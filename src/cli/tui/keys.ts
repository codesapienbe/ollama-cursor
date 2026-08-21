/*  Raw-mode key decoder.
 *  Turns a stdin byte stream into discrete key events, including bracketed
 *  paste (so pasting code never looks like a hundred keystrokes) and the
 *  modifier combinations the editor binds.                               */

const ESC = String.fromCharCode(27);
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

export interface Key {
  /** Logical name: 'a', 'return', 'up', 'backspace', 'tab', … */
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** Raw sequence, useful for debugging unknown keys. */
  sequence: string;
  /** Literal text to insert (printable keys and pastes). */
  text?: string;
  paste?: boolean;
}

const CSI_FINAL_NAMES: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'tab'
};

const TILDE_NAMES: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end'
};

const CTRL_NAMES: Record<number, string> = {
  1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e', 6: 'f', 7: 'g', 8: 'backspace',
  9: 'tab', 10: 'return', 11: 'k', 12: 'l', 13: 'return', 14: 'n', 15: 'o',
  16: 'p', 17: 'q', 18: 'r', 19: 's', 20: 't', 21: 'u', 22: 'v', 23: 'w',
  24: 'x', 25: 'y', 26: 'z'
};

/** Terminal modifier encoding: 1 + bit flags (shift=1, alt=2, ctrl=4). */
function decodeModifiers(parameter: string | undefined): { shift: boolean; meta: boolean; ctrl: boolean } {
  const value = Number(parameter ?? '1');
  const flags = Number.isFinite(value) && value > 1 ? value - 1 : 0;
  return {
    shift: (flags & 1) !== 0,
    meta: (flags & 2) !== 0,
    ctrl: (flags & 4) !== 0
  };
}

export class KeyDecoder {
  private pending = '';
  private pasteBuffer: string | null = null;

  /** Feed a chunk of stdin; returns every complete key event in order. */
  push(chunk: string): Key[] {
    this.pending += chunk;
    const keys: Key[] = [];

    for (;;) {
      if (this.pasteBuffer !== null) {
        const end = this.pending.indexOf(PASTE_END);
        if (end === -1) {
          /* Hold the partial paste until the terminator arrives. */
          this.pasteBuffer += this.pending;
          this.pending = '';
          break;
        }
        const text = this.pasteBuffer + this.pending.slice(0, end);
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.pasteBuffer = null;
        keys.push({ name: 'paste', ctrl: false, meta: false, shift: false, sequence: text, text, paste: true });
        continue;
      }

      if (!this.pending.length) {
        break;
      }

      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.pasteBuffer = '';
        continue;
      }

      const consumed = this.readKey();
      if (!consumed) {
        break;
      }
      keys.push(consumed);
    }

    return keys;
  }

  /** True when a partial escape sequence is still buffered. */
  hasPending(): boolean {
    return this.pending.length > 0 || this.pasteBuffer !== null;
  }

  /** Flush a lone ESC that never became a sequence. */
  flushPendingEscape(): Key[] {
    if (this.pending === ESC) {
      this.pending = '';
      return [{ name: 'escape', ctrl: false, meta: false, shift: false, sequence: ESC }];
    }
    return [];
  }

  private readKey(): Key | null {
    const input = this.pending;
    const first = input.charCodeAt(0);

    if (input[0] === ESC) {
      if (input.length === 1) {
        /* Could be a lone Esc or the start of a sequence: wait one beat. */
        return null;
      }

      if (input[1] === '[' || input[1] === 'O') {
        const match = /^(?:\[|O)([0-9;]*)([A-Za-z~])/.exec(input.slice(1));
        if (!match) {
          if (input.length < 6) {
            return null;
          }
          this.pending = input.slice(2);
          return { name: 'unknown', ctrl: false, meta: false, shift: false, sequence: input.slice(0, 2) };
        }

        const [raw, parameters, final] = match;
        this.pending = input.slice(1 + raw.length);
        const parts = parameters.split(';');
        const modifiers = decodeModifiers(parts.length > 1 ? parts[1] : undefined);

        if (final === '~') {
          const name = TILDE_NAMES[parts[0]] ?? 'unknown';
          return { name, ...modifiers, sequence: `${ESC}${raw}` };
        }

        const name = CSI_FINAL_NAMES[final] ?? 'unknown';
        /* CSI Z is Shift+Tab in every terminal that emits it. */
        const shift = final === 'Z' ? true : modifiers.shift;
        return { name, ctrl: modifiers.ctrl, meta: modifiers.meta, shift, sequence: `${ESC}${raw}` };
      }

      /* Alt + key (including Alt+Enter for a newline). */
      const second = input[1];
      const secondCode = input.charCodeAt(1);
      this.pending = input.slice(2);
      if (secondCode === 13 || secondCode === 10) {
        return { name: 'return', ctrl: false, meta: true, shift: false, sequence: input.slice(0, 2) };
      }
      if (secondCode === 127) {
        return { name: 'backspace', ctrl: false, meta: true, shift: false, sequence: input.slice(0, 2) };
      }
      return {
        name: second.toLowerCase(),
        ctrl: false,
        meta: true,
        shift: second !== second.toLowerCase(),
        sequence: input.slice(0, 2),
        text: undefined
      };
    }

    if (first === 127) {
      this.pending = input.slice(1);
      return { name: 'backspace', ctrl: false, meta: false, shift: false, sequence: input[0] };
    }

    if (first < 32) {
      this.pending = input.slice(1);
      const name = CTRL_NAMES[first] ?? 'unknown';
      const isEnter = first === 13 || first === 10;
      const isTab = first === 9;
      return {
        name,
        ctrl: !isEnter && !isTab && first !== 8,
        meta: false,
        shift: false,
        sequence: input[0]
      };
    }

    /* Printable: consume the whole run of printable characters at once so
       fast typing and non-bracketed pastes stay cheap to render. */
    let end = 0;
    while (end < input.length) {
      const code = input.charCodeAt(end);
      if (code < 32 || code === 127 || input[end] === ESC) {
        break;
      }
      end += 1;
    }

    const text = input.slice(0, end);
    this.pending = input.slice(end);
    return {
      name: text.length === 1 ? text : 'text',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: text,
      text
    };
  }
}
