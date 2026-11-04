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
        raise Failure(f'Telegram rejected the request (HTTP {exc.code}){reason(exc)}.') from None
    except (OSError, ValueError, urllib.error.URLError):
        raise Failure('Network or response failure; outcome uncertain. Do not automatically retry.') from None
    if not isinstance(result, dict) or result.get('ok') is not True or 'result' not in result:
        raise Failure('Telegram did not confirm success. Do not automatically retry.')
    return result['result']


def reason(exc):
    """Telegram's own words for a rejection, e.g. ': Bad Request: PHOTO_INVALID_DIMENSIONS'. The body never holds the token."""
    try:
        description = json.loads(exc.read()).get('description')
    except (OSError, ValueError, AttributeError):
        return ''
    return f': {description}' if isinstance(description, str) else ''


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
PHOTO_LIMIT = 10 * 1024 * 1024  # and on a photo, which Telegram recompresses to a JPEG
# How each kind is sent: the Bot API method, its file field, and the extensions sent that way by default.
# Only formats Telegram plays inline are listed; anything else (WebM, WAV, FLAC, ...) goes as a document.
KINDS = {
    'photo': ('sendPhoto', 'photo', {'.jpg', '.jpeg', '.png', '.webp'}),
    'animation': ('sendAnimation', 'animation', {'.gif'}),
    'video': ('sendVideo', 'video', {'.mp4', '.mov', '.m4v'}),
    'audio': ('sendAudio', 'audio', {'.mp3', '.m4a'}),
    'voice': ('sendVoice', 'voice', {'.ogg', '.oga', '.opus'}),
    'document': ('sendDocument', 'document', set()),
}
VOICE_CODECS = {'opus', 'mp3', 'aac'}  # a voice note in any other codec does not play


def info(path):
    """The file's first video and audio streams and its length, read with ffprobe."""
    if not shutil.which('ffprobe'):
        raise Failure('Sending a video, animation, audio or voice note needs ffprobe (ffmpeg) to read its shape and '
                      'length; without them Telegram guesses, stretching a picture or showing 0:00. '
                      'Install ffmpeg, or send it --as document.')
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                          'stream=codec_type,codec_name,width,height,sample_aspect_ratio:stream_side_data=rotation'
                          ':format=duration', '-of', 'json', path], capture_output=True, text=True)
    try:
        data = json.loads(out.stdout)
        streams = data['streams']
    except (ValueError, KeyError):
        raise Failure(f'ffprobe could not read {path}.') from None
    first = lambda kind: next((x for x in streams if x.get('codec_type') == kind), None)
    try:
        duration = max(1, round(float(data.get('format', {}).get('duration', 0))))
    except ValueError:
        duration = 1
    return first('video'), first('audio'), duration


def aspect(stream):
    """A sample aspect ratio as a number, 1 for square pixels."""
    num, _, den = (stream.get('sample_aspect_ratio') or '1:1').partition(':')
    return int(num) / int(den) if num.isdigit() and den.isdigit() and int(num) and int(den) else 1


def shape(stream):
    """A video's width and height as players show it, sample aspect and rotation applied."""
    width, height = round(int(stream['width']) * aspect(stream)), int(stream['height'])
    rotation = next((d['rotation'] for d in stream.get('side_data_list', []) if 'rotation' in d), 0)
    return (height, width) if abs(int(rotation)) % 180 == 90 else (width, height)


def kind_of(path, size):
    ext = os.path.splitext(path)[1].lower()
    kind = next((k for k, (_, _, exts) in KINDS.items() if ext in exts), 'document')
    if kind == 'photo' and (size > PHOTO_LIMIT or not photo_fits(path)):
        return 'document'
    if kind == 'voice' and (info(path)[1] or {}).get('codec_name') not in VOICE_CODECS:
        return 'document'
    return kind


def photo_fits(path):
    """Whether Telegram takes it as a photo: width plus height at most 10,000 and sides at most 20 to 1.
    Unknown without ffprobe; Telegram then says so itself."""
    if not shutil.which('ffprobe'):
        return True
    video = info(path)[0]
    if not video:
        return True
    w, h = int(video['width']), int(video['height'])
    return w + h <= 10000 and max(w, h) <= 20 * min(w, h)


def square_pixels(path, folder):
    """A copy with square pixels: Telegram files a video by its stored size, so wide pixels show squeezed."""
    if not shutil.which('ffmpeg'):
        raise Failure(f'{path} has non-square pixels, which Telegram shows squeezed; converting it needs ffmpeg.')
    out = os.path.join(folder, os.path.splitext(os.path.basename(path))[0] + '.mp4')
    r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-vf', 'scale=trunc(iw*sar/2)*2:ih:flags=lanczos,setsar=1',
                        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
                        '-movflags', '+faststart', out], capture_output=True)
    if r.returncode != 0:
        raise Failure(f'ffmpeg could not convert {path} to square pixels.')
    if os.path.getsize(out) > UPLOAD_LIMIT:
        raise Failure(f'{path} with square pixels is over 50 MB. Send a smaller copy.')
    return out


def thumbnail(path, duration, folder):
    """A JPEG frame a tenth of the way in, within 320 px a side as the Bot API asks, or None without ffmpeg."""
    if not shutil.which('ffmpeg'):
        return None
    out = os.path.join(folder, 'thumbnail.jpg')
    r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(duration / 10), '-i', path, '-frames:v', '1',
                        '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-q:v', '4', out],
                       capture_output=True)
    return out if r.returncode == 0 and os.path.getsize(out) < 200 * 1024 else None


def send_file(config, path, caption, kind=None, silent=False):
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
    fields = {'chat_id': str(config['chat_id']), 'caption': caption, 'disable_notification': str(silent).lower()}
    files = {field: path}
    with tempfile.TemporaryDirectory() as folder:
        if kind in ('video', 'animation', 'audio', 'voice'):
            # Without these Telegram guesses: a picture stretched to the wrong frame, a length of 0:00.
            video, audio, duration = info(path)
            fields['duration'] = str(duration)
            if kind in ('video', 'animation'):
                if not video:
                    raise Failure(f'{path} has no picture to send as a {kind}.')
                if kind == 'video' and aspect(video) != 1:
                    files[field] = square_pixels(path, folder)
                    video = info(files[field])[0]
                width, height = shape(video)
                fields.update(width=str(width), height=str(height))
                thumb = thumbnail(files[field], duration, folder)
                if thumb:
                    fields['thumbnail'] = 'attach://thumbnail'
                    files['thumbnail'] = thumb
            elif not audio:
                raise Failure(f'{path} has no sound to send as {kind}.')
            elif kind == 'voice' and audio.get('codec_name') not in VOICE_CODECS:
                raise Failure(f'{path} is {audio.get("codec_name")}; a voice note plays only as Opus, MP3 or AAC. '
                              'Send it --as document.')
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
        raise Failure(f'Telegram rejected the upload (HTTP {exc.code}){reason(exc)}.' if exc.code < 500 else
                      'Telegram server error; outcome uncertain. Do not automatically retry.') from None
    except (OSError, ValueError, urllib.error.URLError):
        raise Failure('Network or response failure; outcome uncertain. Do not automatically retry.') from None
    if not isinstance(result, dict) or result.get('ok') is not True or not result.get('result', {}).get('message_id'):
        raise Failure('Telegram did not confirm the upload. Do not automatically retry.')
    message = result['result']
    # How Telegram filed it: a video it cannot play inline comes back as a document, for one.
    shown = next(k for k in ('animation', 'video', 'voice', 'audio', 'photo', 'document') if k in message)
    media = message[shown][-1] if shown == 'photo' else message[shown]
    receipt = {'accepted': True, 'kind': kind, 'shown_as': shown, 'message_id': message['message_id'],
               **{k: media[k] for k in ('width', 'height', 'duration') if k in media}}
    print(json.dumps(receipt))
    if shown != kind:
        print(f'Note: sent as {kind}, but Telegram filed it as {shown}.', file=sys.stderr)
    return receipt


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
    sender_file.add_argument('--silent', action='store_true', help='Deliver without a notification sound')
    args = parser.parse_args()
    try:
        if args.command == 'setup':
            setup()
        elif args.command == 'status':
            config = load()
            print(json.dumps({'configured': True, 'bot_username': config.get('bot_username'),
                              'chat_id': config['chat_id']}))
        elif args.command == 'send-file':
            send_file(load(), args.file, args.caption, args.kind, args.silent)
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
