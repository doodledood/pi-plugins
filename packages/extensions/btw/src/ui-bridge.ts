import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  ExtensionEditorComponent,
  type AutocompleteProviderFactory,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  Component,
  OverlayHandle,
  OverlayOptions,
  TUI,
} from "@earendil-works/pi-tui";
import { settleExactCustomOverlay } from "./custom-overlay.ts";

type EditorFactory = ExtensionUIContext["getEditorComponent"] extends () => infer Factory
  ? NonNullable<Factory>
  : never;

const CUSTOM_SETTLED = Symbol("btw-child-custom-settled");
const INERT_COMPONENT: Component = {
  invalidate() {},
  render() { return []; },
};

function customAbortError(): Error {
  return new DOMException("BTW child UI was closed.", "AbortError");
}

export interface ChildUIBridgeCallbacks {
  onNotice(message: string, type?: "info" | "warning" | "error"): void;
  onStatus(key: string, text: string | undefined): void;
}

function withAbort(
  options: ExtensionUIDialogOptions | undefined,
  closeSignal: AbortSignal,
): ExtensionUIDialogOptions {
  const signal = options?.signal
    ? AbortSignal.any([options.signal, closeSignal])
    : closeSignal;
  return options?.timeout === undefined ? { signal } : { signal, timeout: options.timeout };
}

/**
 * Child dialogs are delegated to Pi's parent UI. Pane-local notices/statuses are
 * supported, but child APIs that would mutate the parent's global shell are
 * intentionally inert (raw input, working-row presentation, widget, footer,
 * header, title, editor text/paste/autocomplete/component, theme, and global
 * tool-expansion setters). The corresponding read APIs return a neutral value
 * except theme/tool expansion reads, which safely reflect the parent.
 */
export class ChildUIBridge {
  readonly context: ExtensionUIContext;
  private readonly closeController = new AbortController();
  private readonly customClosers = new Set<() => void>();
  private disposed = false;

  constructor(parent: ExtensionUIContext, callbacks: ChildUIBridgeCallbacks) {
    const bridge = this;

    this.context = {
      select(title, options, opts) {
        return parent.select(`BTW · ${title}`, options, withAbort(opts, bridge.closeController.signal));
      },
      confirm(title, message, opts) {
        return parent.confirm(`BTW · ${title}`, message, withAbort(opts, bridge.closeController.signal));
      },
      input(title, placeholder, opts) {
        return parent.input(`BTW · ${title}`, placeholder, withAbort(opts, bridge.closeController.signal));
      },
      notify(message, type) {
        callbacks.onNotice(message, type);
      },
      onTerminalInput() {
        // No-op: a child listener would observe parent input after /main.
        return () => {};
      },
      setStatus(key, text) {
        callbacks.onStatus(key, text);
      },
      setWorkingMessage(message) {
        callbacks.onStatus("working", message);
      },
      // No-ops: these mutate global parent working/thinking presentation.
      setWorkingVisible() {},
      setWorkingIndicator() {},
      setHiddenThinkingLabel() {},
      // No-op: child widgets would be mounted in the parent's global shell.
      setWidget(_key: string, _content: string[] | ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined, _options?: ExtensionWidgetOptions) {},
      // No-ops: child extensions may not replace parent shell components/title.
      setFooter() {},
      setHeader() {},
      setTitle() {},
      custom<T>(
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (result: T) => void,
        ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
        options?: {
          overlay?: boolean;
          overlayOptions?: OverlayOptions | (() => OverlayOptions);
          onHandle?: (handle: OverlayHandle) => void;
        },
      ): Promise<T> {
        if (bridge.disposed || bridge.closeController.signal.aborted) {
          return Promise.reject(customAbortError());
        }

        return new Promise<T>((resolve, reject) => {
          let outerSettled = false;
          let cancelled = false;
          let childCompleted = false;
          let overlayHandle: OverlayHandle | undefined;
          let overlayTui: TUI | undefined;
          let hostDone: ((result: typeof CUSTOM_SETTLED) => void) | undefined;
          let releaseFactoryForCancellation: (() => void) | undefined;
          let hostSettlementStarted = false;

          const removeCloser = () => bridge.customClosers.delete(cancel);
          const settleHost = () => {
            if (hostSettlementStarted || !hostDone) return;
            if (options?.overlay) {
              if (!overlayTui || !overlayHandle) return;
              hostSettlementStarted = true;
              settleExactCustomOverlay(
                overlayTui,
                overlayHandle,
                () => hostDone?.(CUSTOM_SETTLED),
              );
              return;
            }
            hostSettlementStarted = true;
            hostDone(CUSTOM_SETTLED);
          };
          const finish = (value: T) => {
            if (cancelled || outerSettled) return;
            childCompleted = true;
            outerSettled = true;
            removeCloser();
            resolve(value);
            settleHost();
          };
          const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            releaseFactoryForCancellation?.();
            if (!outerSettled) {
              outerSettled = true;
              reject(customAbortError());
            }
            removeCloser();
            settleHost();
          };
          bridge.customClosers.add(cancel);

          let hostPromise: Promise<typeof CUSTOM_SETTLED>;
          try {
            hostPromise = parent.custom<typeof CUSTOM_SETTLED>(
              async (tui, theme, keybindings, done) => {
                overlayTui = tui;
                hostDone = done;
                if (cancelled || bridge.closeController.signal.aborted) {
                  cancelled = true;
                  return INERT_COMPONENT;
                }

                const childComponent = Promise.resolve()
                  .then(() => factory(tui, theme, keybindings, finish));
                const cancelledComponent = new Promise<Component>((resolveCancelled) => {
                  releaseFactoryForCancellation = () => resolveCancelled(INERT_COMPONENT);
                });
                const component = await Promise.race([childComponent, cancelledComponent]);
                if (component === INERT_COMPONENT) {
                  void childComponent.then((lateComponent) => lateComponent.dispose?.()).catch(() => {});
                }
                return component;
              },
              {
                ...(options?.overlay === undefined ? {} : { overlay: options.overlay }),
                ...(options?.overlayOptions === undefined ? {} : { overlayOptions: options.overlayOptions }),
                onHandle(handle) {
                  overlayHandle = handle;
                  if (!cancelled) options?.onHandle?.(handle);
                  if (cancelled || childCompleted) settleHost();
                },
              },
            );
          } catch (error) {
            removeCloser();
            reject(error);
            return;
          }

          void hostPromise.catch((error: unknown) => {
            removeCloser();
            if (outerSettled) return;
            outerSettled = true;
            reject(error);
          });
        });
      },
      // No-ops/neutral read: child extensions cannot mutate the parent editor.
      pasteToEditor() {},
      setEditorText() {},
      getEditorText() {
        return "";
      },
      editor(title, prefill) {
        if (bridge.closeController.signal.aborted) return Promise.resolve(undefined);
        return bridge.context.custom<string | undefined>((tui, _theme, keybindings, done) =>
          new ExtensionEditorComponent(
            tui,
            keybindings,
            `BTW · ${title}`,
            prefill,
            (value) => done(value),
            () => done(undefined),
          ),
        );
      },
      // No-ops: these would alter the parent's editor/autocomplete globally.
      addAutocompleteProvider(_factory: AutocompleteProviderFactory) {},
      setEditorComponent(_factory: EditorFactory | undefined) {},
      getEditorComponent() {
        return undefined;
      },
      get theme(): Theme {
        return parent.theme;
      },
      getAllThemes() {
        return parent.getAllThemes();
      },
      getTheme(name) {
        return parent.getTheme(name);
      },
      setTheme() {
        return { success: false, error: "Child extensions cannot change the parent theme." };
      },
      getToolsExpanded() {
        return parent.getToolsExpanded();
      },
      // No-op: expansion is global parent transcript state.
      setToolsExpanded() {},
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeController.abort();
    for (const close of [...this.customClosers]) close();
    this.customClosers.clear();
  }
}
