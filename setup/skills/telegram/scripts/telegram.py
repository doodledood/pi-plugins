#!/usr/bin/env python3
"""One-way Telegram delivery using only the Python standard library."""
import argparse
import getpass
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid

CONFIG = Path.home() / '.config' / 'telegram-notify' / 'config.json'


class Failure(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(token, method, payload):
    request = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/{method}',
        data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        # Do not expose an exception's URL: it contains the bot token.
        if exc.code >= 500:
            raise Failure('Telegram server error; outcome uncertain. Do not automatically retry.') from None
        raise Failure(f'Telegram rejected the request (HTTP {exc.code}).') from None
    except (OSError, ValueError, urllib.error.URLError):
        raise Failure('Network or response failure; outcome uncertain. Do not automatically retry.') from None
    if not isinstance(result, dict) or result.get('ok') is not True or 'result' not in result:
        raise Failure('Telegram did not confirm success. Do not automatically retry.')
    return result['result']


def validate(config):
    if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]+', str(config.get('token', ''))):
        raise Failure('Invalid bot token format.')
    chat_id = config.get('chat_id')
    if type(chat_id) is not int or chat_id <= 0:
        raise Failure('A private user chat ID is required.')
    return config


def load():
    if not CONFIG.exists():
        raise Failure('Telegram is not configured. Run this helper with setup in your terminal.')
    if CONFIG.is_symlink() or CONFIG.stat().st_mode & 0o077:
        raise Failure('Config must be a regular owner-only file (chmod 600).')
    try:
        return validate(json.loads(CONFIG.read_text()))
    except (ValueError, AttributeError):
        raise Failure('Invalid Telegram configuration. Run setup again.') from None


def save(config):
    validate(config)
    CONFIG.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(CONFIG.parent, 0o700)
    fd, temp = tempfile.mkstemp(dir=CONFIG.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(config, stream)
            stream.write('\n')
        os.replace(temp, CONFIG)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def setup():
    if not sys.stdin.isatty():
        raise Failure('Run setup in your own interactive terminal so token entry stays private.')
    if CONFIG.exists() and input('Replace existing Telegram configuration? [y/N] ').lower() != 'y':
        raise Failure('Setup cancelled; existing configuration unchanged.')
    token = getpass.getpass('BotFather token (hidden): ').strip()
    validate({'token': token, 'chat_id': 1})
    bot = api(token, 'getMe', {})
    if api(token, 'getWebhookInfo', {}).get('url'):
        raise Failure('This bot has an active webhook. Use a dedicated notification bot; webhook unchanged.')
    phrase = 'pair-' + secrets.token_hex(12)
    print(f"Open https://t.me/{bot['username']} in Telegram, tap Start, and send exactly:\n{phrase}")
    input('After sending it, press Enter here: ')
    updates = api(token, 'getUpdates', {'limit': 100, 'timeout': 0})
    matches = {u['message']['chat']['id'] for u in updates
               if u.get('message', {}).get('text') == phrase
               and u['message']['chat'].get('type') == 'private'}
    if len(matches) != 1:
        raise Failure('Pairing message not found uniquely. Run setup again; no configuration was saved.')
    save({'token': token, 'chat_id': matches.pop(), 'bot_username': bot['username']})
    print('Configured. No message sent. Run send to test delivery.')


def send(config, text):
    if not text.strip() or len(text.encode('utf-16-le')) // 2 > 4096:
        raise Failure('Message must contain text and fit within 4,096 UTF-16 units.')
    result = api(config['token'], 'sendMessage', {
        'chat_id': config['chat_id'], 'text': text,
        'disable_notification': False, 'link_preview_options': {'is_disabled': True}})
    if not isinstance(result, dict) or not result.get('message_id'):
        raise Failure('Missing send receipt; outcome uncertain. Do not automatically retry.')
    print(json.dumps({'accepted': True, 'message_id': result['message_id']}))


UPLOAD_LIMIT = 50 * 1024 * 1024  # the Bot API's limit on any uploaded file
PHOTO_LIMIT = 10 * 1024 * 1024  # and on a photo, which Telegram recompresses
# How each kind is sent: the Bot API method, its file field, and the extensions sent that way by default.
KINDS = {
    'photo': ('sendPhoto', 'photo', {'.jpg', '.jpeg', '.png', '.webp'}),
    'animation': ('sendAnimation', 'animation', {'.gif'}),
    'video': ('sendVideo', 'video', {'.mp4', '.mov', '.m4v', '.webm'}),
    'audio': ('sendAudio', 'audio', {'.mp3', '.m4a', '.flac', '.wav', '.aac'}),
    'voice': ('sendVoice', 'voice', {'.ogg', '.oga', '.opus'}),
    'document': ('sendDocument', 'document', set()),
}


def kind_of(path, size):
    ext = os.path.splitext(path)[1].lower()
    kind = next((k for k, (_, _, exts) in KINDS.items() if ext in exts), 'document')
    return 'document' if kind == 'photo' and size > PHOTO_LIMIT else kind


def probe(path):
    """A video's shape as players show it (sample aspect and rotation applied) and its length, read with ffprobe."""
    if not shutil.which('ffprobe'):
        raise Failure('Sending a video needs ffprobe (ffmpeg) to read its shape; without it Telegram guesses and '
                      'can squeeze the picture. Install ffmpeg, or send it --as document.')
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height,sample_aspect_ratio:stream_side_data=rotation:format=duration',
                          '-of', 'json', path], capture_output=True, text=True)
    try:
        info = json.loads(out.stdout)
        stream = info['streams'][0]
        width, height = int(stream['width']), int(stream['height'])
        duration = float(info['format']['duration'])
    except (ValueError, KeyError, IndexError, TypeError):
        raise Failure(f'ffprobe could not read the video shape of {path}.') from None
    num, _, den = (stream.get('sample_aspect_ratio') or '1:1').partition(':')
    if num.isdigit() and den.isdigit() and int(num) and int(den):
        width = round(width * int(num) / int(den))
    rotation = next((d.get('rotation') for d in stream.get('side_data_list', []) if 'rotation' in d), 0)
    if abs(int(rotation)) % 180 == 90:
        width, height = height, width
    return width, height, max(1, round(duration))


def thumbnail(path, duration, folder):
    """A JPEG frame a tenth of the way in, within 320 px a side as the Bot API asks, or None without ffmpeg."""
    if not shutil.which('ffmpeg'):
        return None
    out = os.path.join(folder, 'thumbnail.jpg')
    r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(duration / 10), '-i', path, '-frames:v', '1',
                        '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-q:v', '4', out],
                       capture_output=True)
    return out if r.returncode == 0 and os.path.getsize(out) < 200 * 1024 else None


def send_file(config, path, caption, kind=None):
    """Upload a file to the configured user, sent as the kind Telegram shows best (a photo, video, ...) or as asked."""
    size = os.path.getsize(path)
    if size > UPLOAD_LIMIT:
        raise Failure(f'{path} is {size / 2**20:.1f} MB; Telegram bots upload at most 50 MB. Send a smaller copy.')
    kind = kind or kind_of(path, size)
    if kind == 'photo' and size > PHOTO_LIMIT:
        raise Failure(f'{path} is {size / 2**20:.1f} MB; a photo is at most 10 MB. Send it as a document.')
    if len(caption.encode('utf-16-le')) // 2 > 1024:
        raise Failure('Caption must fit within 1,024 UTF-16 units.')
    method, field, _ = KINDS[kind]
    fields = {'chat_id': str(config['chat_id']), 'caption': caption}
    files = {field: path}
    with tempfile.TemporaryDirectory() as folder:
        if kind in ('video', 'animation'):
            # Without its shape Telegram guesses one, and shows the picture stretched to it.
            width, height, duration = probe(path)
            fields.update(width=str(width), height=str(height), duration=str(duration))
            thumb = thumbnail(path, duration, folder)
            if thumb:
                fields['thumbnail'] = 'attach://thumbnail'
                files['thumbnail'] = thumb
        if kind == 'video':
            fields['supports_streaming'] = 'true'
        boundary = uuid.uuid4().hex
        body = b''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
                        for k, v in fields.items())
        for name, file in files.items():
            mime = mimetypes.guess_type(file)[0] or 'application/octet-stream'
            filename = os.path.basename(file).replace('"', '')
            body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                     f'Content-Type: {mime}\r\n\r\n').encode()
            with open(file, 'rb') as f:
                body += f.read() + b'\r\n'
        body += f'--{boundary}--\r\n'.encode()
    request = urllib.request.Request(
        f'https://api.telegram.org/bot{config["token"]}/{method}', data=body,
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'}, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=600) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        # Do not expose an exception's URL: it contains the bot token.
        raise Failure(f'Telegram rejected the upload (HTTP {exc.code}).' if exc.code < 500 else
                      'Telegram server error; outcome uncertain. Do not automatically retry.') from None
    except (OSError, ValueError, urllib.error.URLError):
        raise Failure('Network or response failure; outcome uncertain. Do not automatically retry.') from None
    if not isinstance(result, dict) or result.get('ok') is not True or not result.get('result', {}).get('message_id'):
        raise Failure('Telegram did not confirm the upload. Do not automatically retry.')
    sent = result['result'].get(field) or {}
    print(json.dumps({'accepted': True, 'kind': kind, 'message_id': result['result']['message_id'],
                      **({'shown': f'{sent["width"]}x{sent["height"]}'} if 'width' in sent else {})}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('setup', help='Privately configure bot token and pair your private chat')
    commands.add_parser('status', help='Show configuration status without exposing the token')
    sender = commands.add_parser('send', help='Send literal text to the configured user')
    sender.add_argument('--text', help='Message text; otherwise read standard input')
    sender_file = commands.add_parser('send-file', help='Upload a photo, video, audio, voice note or other file (at most 50 MB)')
    sender_file.add_argument('--file', required=True, help='The file to send')
    sender_file.add_argument('--caption', default='', help='Plain-text caption, at most 1,024 characters')
    sender_file.add_argument('--as', dest='kind', choices=list(KINDS), help='How to send it (default: by its extension)')
    args = parser.parse_args()
    try:
        if args.command == 'setup':
            setup()
        elif args.command == 'status':
            config = load()
            print(json.dumps({'configured': True, 'bot_username': config.get('bot_username'),
                              'chat_id': config['chat_id']}))
        elif args.command == 'send-file':
            send_file(load(), args.file, args.caption, args.kind)
        else:
            if args.text is None and sys.stdin.isatty():
                raise Failure('Supply --text or pipe a message through standard input.')
            send(load(), args.text if args.text is not None else sys.stdin.read())
    except Failure as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except (OSError, EOFError, KeyboardInterrupt):
        print('Local operation failed or was cancelled; no automatic retry.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
