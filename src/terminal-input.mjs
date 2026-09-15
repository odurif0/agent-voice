import { StringDecoder } from 'node:string_decoder';

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
export const SHORTCUTS = {
  'ctrl+alt+z': ['\x1b\x1a', '\x1b[122;7u', '\x1b[122;7:1u', '\x1b[27;7;122~'],
  f2: ['\x1bOQ', '\x1b[12~', '\x1b[57365u'],
};

// Speech is data, never terminal control, a pasted command delimiter, or Enter.
export function cleanTranscript(text) {
  return String(text).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function pastedTranscript(text) { return PASTE_START + cleanTranscript(text) + PASTE_END; }

/** Decode only our shortcut/Escape; forward all other bytes, including UTF-8 and pasted shortcuts. */
export class InputRouter {
  #buffer = '';
  #paste = false;
  #timer;
  #decoder = new StringDecoder('utf8');
  constructor({ shortcut, onData, onToggle, onCancel, onEnter, escapeTimeout = 80 }) {
    if (!SHORTCUTS[shortcut]) throw new Error(`Unsupported shortcut: ${shortcut}`);
    Object.assign(this, { shortcut, onData, onToggle, onCancel, onEnter, escapeTimeout });
  }
  feed(chunk) {
    clearTimeout(this.#timer);
    this.#buffer += Buffer.isBuffer(chunk) ? this.#decoder.write(chunk) : chunk;
    this.#drain(false);
    if (this.#buffer) this.#timer = setTimeout(() => this.#drain(true), this.escapeTimeout);
  }
  #drain(flush) {
    const shortcuts = SHORTCUTS[this.shortcut];
    while (this.#buffer) {
      if (this.#paste) {
        const end = this.#buffer.indexOf(PASTE_END);
        if (end >= 0) {
          this.onData(this.#buffer.slice(0, end + PASTE_END.length));
          this.#buffer = this.#buffer.slice(end + PASTE_END.length); this.#paste = false; continue;
        }
        let keep = 0;
        if (!flush) for (let n = 1; n < PASTE_END.length; n++) if (this.#buffer.endsWith(PASTE_END.slice(0, n))) keep = n;
        const body = this.#buffer.slice(0, this.#buffer.length - keep);
        if (body) this.onData(body);
        this.#buffer = this.#buffer.slice(this.#buffer.length - keep); return;
      }
      if (this.#buffer.startsWith(PASTE_START)) {
        this.onData(PASTE_START); this.#buffer = this.#buffer.slice(PASTE_START.length); this.#paste = true; continue;
      }
      const shortcut = shortcuts.find(key => this.#buffer.startsWith(key));
      if (shortcut) { this.#buffer = this.#buffer.slice(shortcut.length); this.onToggle(); continue; }
      if (!flush && [PASTE_START, ...shortcuts].some(key => key.startsWith(this.#buffer))) return;
      if (this.#buffer[0] === '\x1b') {
        // Forward a complete CSI/SS3 escape sequence as a unit (arrows, cursor replies…).
        const seq = this.#buffer.match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[ -~])/);
        if (seq) { this.onData(seq[0]); this.#buffer = this.#buffer.slice(seq[0].length); continue; }
        if (!flush && (this.#buffer === '\x1b' || /^\x1b\[[0-?]*[ -/]*$/.test(this.#buffer) || this.#buffer === '\x1bO')) return;
        if (this.#buffer === '\x1b') { this.#buffer = ''; this.onCancel('\x1b'); continue; }
      }
      const char = String.fromCodePoint(this.#buffer.codePointAt(0)); this.#buffer = this.#buffer.slice(char.length);
      if (char === '\x03') this.onCancel(char);
      else if ((char === '\r' || char === '\n') && this.onEnter) this.onEnter(char);
      else this.onData(char);
    }
  }
  dispose() { clearTimeout(this.#timer); this.#buffer = ''; }
}

/** Parse the child's control stream: never inject the status bar inside an ANSI
 * sequence, an OSC/DCS string, or Forge's save-cursor/right-prompt/restore pair. */
export class PasteReadiness {
  enabled = false;
  #state = 'ground';
  #csi = '';
  #saved = false;
  get safeToDraw() { return this.#state === 'ground' && !this.#saved; }
  feed(chunk) {
    for (const char of chunk) {
      if (this.#state === 'string') {
        if (char === '\x07') this.#state = 'ground';
        else if (char === '\x1b') this.#state = 'string-escape';
      } else if (this.#state === 'string-escape') {
        this.#state = char === '\\' ? 'ground' : 'string';
      } else if (this.#state === 'charset') this.#state = 'ground';
      else if (this.#state === 'escape') {
        if (char === '[') { this.#state = 'csi'; this.#csi = ''; }
        else if (']P^_'.includes(char)) this.#state = 'string';
        else if ('()*+'.includes(char)) this.#state = 'charset';
        else {
          if (char === '7') this.#saved = true;
          if (char === '8' || char === 'c') this.#saved = false;
          this.#state = 'ground';
        }
      } else if (this.#state === 'csi') {
        if (char >= '@' && char <= '~') {
          if (this.#csi === '?2004' && ['h', 'l'].includes(char)) this.enabled = char === 'h';
          if (this.#csi === '' && char === 's') this.#saved = true;
          if (this.#csi === '' && char === 'u') this.#saved = false;
          this.#state = 'ground';
        } else this.#csi = (this.#csi + char).slice(-100);
      } else if (char === '\x1b') this.#state = 'escape';
      if (char === '\x18' || char === '\x1a') this.#state = 'ground';
    }
    return this.enabled;
  }
}

/** Conservative cell budget, including emoji/combining sequences, without a Pi dependency. */
export function fitStatus(text, columns) {
  let result = '', used = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    const width = /[\u20e3\ufe0f]/u.test(segment) ? 2 : /^[\x20-\x7e\u00a0-\u024f]/u.test(segment) ? 1 : /^\p{Mark}+$/u.test(segment) ? 0 : 2;
    if (used + width > columns) break;
    used += width; result += segment;
  }
  return result;
}
