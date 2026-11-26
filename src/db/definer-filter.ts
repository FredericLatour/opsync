const MAX_CANDIDATE_BYTES = 4096;

function isAsciiSpace(b: number): boolean {
    return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c || b === 0x0b;
}

function isAsciiDigit(b: number): boolean {
    return b >= 0x30 && b <= 0x39;
}

function isWordOrDollar(b: number): boolean {
    return (
        (b >= 0x30 && b <= 0x39) ||
        (b >= 0x41 && b <= 0x5a) ||
        (b >= 0x61 && b <= 0x7a) ||
        b === 0x5f ||
        b === 0x24
    );
}

function toLowerAscii(b: number): number {
    return b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
}

function skipSpaces(buf: number[], p: number): number {
    while (p < buf.length && isAsciiSpace(buf[p] ?? -1)) p++;
    return p;
}

type TokenResult = { status: "need_more" } | { status: "fail" } | { status: "ok"; end: number };

function parseDefinerToken(buf: number[], start: number, stopByte: number, eof: boolean): TokenResult {
    if (start >= buf.length) return eof ? { status: "fail" } : { status: "need_more" };
    const first = buf[start] ?? -1;
    if (first === 0x60 || first === 0x27) {
        let p = start + 1;
        while (p < buf.length) {
            if (buf[p] === first) {
                p++;
                if (p < buf.length) {
                    if (buf[p] === first) {
                        p++;
                        continue;
                    }
                    return { status: "ok", end: p };
                }
                return eof ? { status: "ok", end: p } : { status: "need_more" };
            }
            p++;
        }
        return eof ? { status: "fail" } : { status: "need_more" };
    }

    let p = start;
    while (p < buf.length) {
        const b = buf[p] ?? -1;
        if (isAsciiSpace(b) || b === stopByte) break;
        // Do not consume closing `*/` of an executable comment.
        if (b === 0x2a) {
            if (p + 1 >= buf.length) return eof ? { status: "ok", end: p + 1 } : { status: "need_more" };
            if (buf[p + 1] === 0x2f) break;
        }
        p++;
    }
    if (p >= buf.length && !eof) return { status: "need_more" };
    return p > start ? { status: "ok", end: p } : { status: "fail" };
}

type ClauseResult =
    | { status: "need_more" }
    | { status: "fail" }
    | { status: "match"; end: number };

function tryParseDefinerClause(buf: number[], eof: boolean): ClauseResult {
    const keyword = "definer";
    for (let i = 0; i < Math.min(buf.length, keyword.length); i++) {
        if (toLowerAscii(buf[i] ?? -1) !== keyword.charCodeAt(i)) return { status: "fail" };
    }
    if (buf.length < keyword.length) return eof ? { status: "fail" } : { status: "need_more" };

    let p = skipSpaces(buf, keyword.length);
    if (p >= buf.length) return eof ? { status: "fail" } : { status: "need_more" };
    if (buf[p] !== 0x3d) return { status: "fail" }; // '='
    p = skipSpaces(buf, p + 1);
    if (p >= buf.length) return eof ? { status: "fail" } : { status: "need_more" };

    // Try `CURRENT_USER` / `CURRENT_USER()`
    const cu = "current_user";
    let cuPrefixMatch = true;
    for (let i = 0; i < Math.min(buf.length - p, cu.length); i++) {
        if (toLowerAscii(buf[p + i] ?? -1) !== cu.charCodeAt(i)) {
            cuPrefixMatch = false;
            break;
        }
    }
    if (cuPrefixMatch) {
        if (buf.length - p < cu.length) {
            return eof ? { status: "fail" } : { status: "need_more" };
        }
        const afterCu = p + cu.length;
        // Could still be `current_user@host` if followed by `@`
        if (afterCu >= buf.length) {
            return eof ? { status: "match", end: afterCu } : { status: "need_more" };
        }
        if (buf[afterCu] !== 0x40) {
            let q = afterCu;
            if (buf[q] === 0x28) {
                if (q + 1 >= buf.length) return eof ? { status: "fail" } : { status: "need_more" };
                if (buf[q + 1] === 0x29) q += 2;
            }
            const end = skipSpaces(buf, q);
            if (end >= buf.length && !eof) return { status: "need_more" };
            return { status: "match", end };
        }
    }

    // Parse `user@host`
    const user = parseDefinerToken(buf, p, 0x40, eof);
    if (user.status !== "ok") return user;
    if (user.end >= buf.length) return eof ? { status: "fail" } : { status: "need_more" };
    if (buf[user.end] !== 0x40) return { status: "fail" };

    const host = parseDefinerToken(buf, user.end + 1, 0x3b, eof);
    if (host.status !== "ok") return host;
    const end = skipSpaces(buf, host.end);
    if (end >= buf.length && !eof) return { status: "need_more" };
    return { status: "match", end };
}

type State =
    | "normal"
    | "quote"
    | "line_comment"
    | "dash_pending"
    | "slash_pending"
    | "plain_block_comment"
    | "block_comment_bang"
    | "exec_definer_check"
    | "discard_block_comment"
    | "maybe_definer";

/**
 * Incremental byte-level MySQL DEFINER stripper.
 * Processes arbitrary chunk boundaries without UTF-8 decoding so binary literals stay intact.
 */
export class DefinerStripper {
    private state: State = "normal";
    private inExecComment = false;
    private prevByte = -1;
    private quoteChar = 0;
    private quoteEscaped = false;
    private quoteMaybeDouble = false;
    private blockStarPending = false;
    private execStarPending = false;
    private pending: number[] = [];

    push(chunk: Uint8Array): Uint8Array {
        const out: number[] = [];
        for (let i = 0; i < chunk.length; i++) {
            this.step(chunk[i] ?? 0, out);
        }
        return out.length > 0 ? new Uint8Array(out) : new Uint8Array(0);
    }

    finish(): Uint8Array {
        const out: number[] = [];
        if (this.state === "quote" && this.quoteMaybeDouble) {
            this.quoteMaybeDouble = false;
            this.state = "normal";
        } else if (this.state === "maybe_definer") {
            const res = tryParseDefinerClause(this.pending, true);
            if (res.status === "match") {
                const tail = this.pending.slice(res.end);
                this.pending = [];
                this.state = "normal";
                this.prevByte = 0x20;
                for (const b of tail) this.step(b, out);
            } else {
                this.flushPendingRaw(out);
            }
        } else if (
            this.state === "dash_pending" ||
            this.state === "slash_pending" ||
            this.state === "block_comment_bang" ||
            this.state === "exec_definer_check"
        ) {
            this.flushPendingRaw(out);
        }
        if (this.execStarPending) {
            out.push(0x2a);
            this.execStarPending = false;
        }
        return out.length > 0 ? new Uint8Array(out) : new Uint8Array(0);
    }

    private flushPendingRaw(out: number[]): void {
        for (const b of this.pending) {
            out.push(b);
            this.prevByte = b;
        }
        this.pending = [];
        this.state = "normal";
    }

    private emitByte(b: number, out: number[]): void {
        out.push(b);
        this.prevByte = b;
    }

    private step(b: number, out: number[]): void {
        // Re-entry loop avoids recursion when buffered bytes are replayed.
        const replay: number[] = [b];
        while (replay.length > 0) {
            const cur = replay.shift() ?? 0;

            if (this.state === "quote") {
                if (this.quoteMaybeDouble) {
                    this.quoteMaybeDouble = false;
                    if (cur === this.quoteChar) {
                        this.emitByte(cur, out);
                        continue;
                    }
                    this.state = "normal";
                    replay.unshift(cur);
                    continue;
                }
                this.emitByte(cur, out);
                if (this.quoteEscaped) {
                    this.quoteEscaped = false;
                } else if (cur === 0x5c && this.quoteChar !== 0x60) {
                    this.quoteEscaped = true;
                } else if (cur === this.quoteChar) {
                    this.quoteMaybeDouble = true;
                }
                continue;
            }

            if (this.state === "line_comment") {
                this.emitByte(cur, out);
                if (cur === 0x0a) this.state = "normal";
                continue;
            }

            if (this.state === "plain_block_comment") {
                this.emitByte(cur, out);
                if (this.blockStarPending) {
                    if (cur === 0x2f) {
                        this.blockStarPending = false;
                        this.state = "normal";
                    } else {
                        this.blockStarPending = cur === 0x2a;
                    }
                } else if (cur === 0x2a) {
                    this.blockStarPending = true;
                }
                continue;
            }

            if (this.state === "discard_block_comment") {
                if (this.blockStarPending) {
                    if (cur === 0x2f) {
                        this.blockStarPending = false;
                        this.state = "normal";
                        this.prevByte = 0x20;
                    } else {
                        this.blockStarPending = cur === 0x2a;
                    }
                } else if (cur === 0x2a) {
                    this.blockStarPending = true;
                }
                continue;
            }

            if (this.state === "dash_pending") {
                this.pending.push(cur);
                if (this.pending.length === 2) {
                    if (cur !== 0x2d) {
                        const rest = this.pending.slice(1);
                        this.emitByte(this.pending[0] ?? 0x2d, out);
                        this.pending = [];
                        this.state = "normal";
                        replay.unshift(...rest);
                    }
                    continue;
                }
                // length === 3: `--` + third byte
                if (isAsciiSpace(cur)) {
                    for (const x of this.pending) this.emitByte(x, out);
                    this.pending = [];
                    this.state = cur === 0x0a ? "normal" : "line_comment";
                } else {
                    const rest = this.pending.slice(1);
                    this.emitByte(this.pending[0] ?? 0x2d, out);
                    this.pending = [];
                    this.state = "normal";
                    replay.unshift(...rest);
                }
                continue;
            }

            if (this.state === "slash_pending") {
                if (cur === 0x2a) {
                    this.pending.push(cur); // now ['/', '*']
                    this.state = "block_comment_bang";
                } else {
                    this.emitByte(0x2f, out);
                    this.pending = [];
                    this.state = "normal";
                    replay.unshift(cur);
                }
                continue;
            }

            if (this.state === "block_comment_bang") {
                this.pending.push(cur);
                // pending starts with ['/', '*']
                if (this.pending.length === 3) {
                    if (cur !== 0x21) {
                        // Plain block comment `/*...`
                        for (const x of this.pending) this.emitByte(x, out);
                        this.pending = [];
                        this.state = "plain_block_comment";
                        this.blockStarPending = cur === 0x2a;
                    }
                    continue;
                }
                if (this.pending.length === 4) {
                    if (!isAsciiDigit(cur)) {
                        for (const x of this.pending) this.emitByte(x, out);
                        this.pending = [];
                        this.state = "plain_block_comment";
                        this.blockStarPending = cur === 0x2a;
                    }
                    continue;
                }
                // Reading version digits after `/*!`
                if (isAsciiDigit(cur) && this.pending.length < 16) {
                    continue;
                }
                if (isAsciiSpace(cur)) {
                    const versionLen = this.pending.length - 4; // excludes '/', '*', '!', and trailing space
                    const isDefinerVersion =
                        versionLen === 5 &&
                        this.pending[3] === 0x35 &&
                        this.pending[4] === 0x30 &&
                        this.pending[5] === 0x30 &&
                        ((this.pending[6] === 0x31 && this.pending[7] === 0x33) ||
                            (this.pending[6] === 0x32 && this.pending[7] === 0x30));
                    if (isDefinerVersion) {
                        this.state = "exec_definer_check";
                    } else {
                        for (const x of this.pending) this.emitByte(x, out);
                        this.pending = [];
                        this.state = "normal";
                        this.inExecComment = true;
                        this.execStarPending = false;
                    }
                    continue;
                }
                // Not a versioned executable comment (e.g. `/*!50013*/` or non-space after digits)
                const endsHere = this.pending[this.pending.length - 2] === 0x2a && cur === 0x2f;
                for (const x of this.pending) this.emitByte(x, out);
                this.pending = [];
                this.state = endsHere ? "normal" : "plain_block_comment";
                this.blockStarPending = !endsHere && cur === 0x2a;
                continue;
            }

            if (this.state === "exec_definer_check") {
                this.pending.push(cur);
                // pending = ['/', '*', '!', '5', '0', '0', '1', '3', space, ...body]
                const bodyStart = skipSpaces(this.pending, 8);
                if (bodyStart >= this.pending.length) {
                    if (this.pending.length > MAX_CANDIDATE_BYTES) {
                        for (const x of this.pending) this.emitByte(x, out);
                        this.pending = [];
                        this.state = "normal";
                        this.inExecComment = true;
                    }
                    continue;
                }
                const rem = this.pending.length - bodyStart;
                const kw = "definer";
                let kwOk = true;
                for (let k = 0; k < Math.min(rem, kw.length); k++) {
                    if (toLowerAscii(this.pending[bodyStart + k] ?? -1) !== kw.charCodeAt(k)) {
                        kwOk = false;
                        break;
                    }
                }
                if (!kwOk) {
                    const headerEnd = 9; // through first space after `/*!50013`
                    for (let k = 0; k < headerEnd; k++) this.emitByte(this.pending[k] ?? 0, out);
                    const tail = this.pending.slice(headerEnd);
                    this.pending = [];
                    this.state = "normal";
                    this.inExecComment = true;
                    this.execStarPending = false;
                    replay.unshift(...tail);
                    continue;
                }
                if (rem < kw.length) continue;
                const afterKw = skipSpaces(this.pending, bodyStart + kw.length);
                if (afterKw >= this.pending.length) {
                    if (this.pending.length > MAX_CANDIDATE_BYTES) {
                        for (const x of this.pending) this.emitByte(x, out);
                        this.pending = [];
                        this.state = "normal";
                        this.inExecComment = true;
                    }
                    continue;
                }
                if (this.pending[afterKw] === 0x3d) {
                    // Confirmed `/*!50013 DEFINER=...` — discard until `*/`
                    this.pending = [];
                    this.state = "discard_block_comment";
                    this.blockStarPending = false;
                    continue;
                }
                // Not `DEFINER=` — emit header and replay body inside exec comment
                const headerEnd = 9;
                for (let k = 0; k < headerEnd; k++) this.emitByte(this.pending[k] ?? 0, out);
                const tail = this.pending.slice(headerEnd);
                this.pending = [];
                this.state = "normal";
                this.inExecComment = true;
                this.execStarPending = false;
                replay.unshift(...tail);
                continue;
            }

            if (this.state === "maybe_definer") {
                this.pending.push(cur);
                const res = tryParseDefinerClause(this.pending, false);
                if (res.status === "need_more" && this.pending.length < MAX_CANDIDATE_BYTES) {
                    continue;
                }
                if (res.status === "match") {
                    const tail = this.pending.slice(res.end);
                    this.pending = [];
                    this.state = "normal";
                    this.prevByte = 0x20;
                    replay.unshift(...tail);
                    continue;
                }
                // Failed to match: emit first byte ('D'/'d'), replay remainder
                const first = this.pending[0] ?? 0;
                const tail = this.pending.slice(1);
                this.emitByte(first, out);
                this.pending = [];
                this.state = "normal";
                replay.unshift(...tail);
                continue;
            }

            // ── state === "normal" (either top-level or inside an executable comment) ──
            if (this.inExecComment) {
                if (this.execStarPending) {
                    if (cur === 0x2f) {
                        this.emitByte(0x2a, out);
                        this.emitByte(0x2f, out);
                        this.execStarPending = false;
                        this.inExecComment = false;
                        continue;
                    }
                    this.emitByte(0x2a, out);
                    this.execStarPending = false;
                    // Fall through to process `cur`
                }
                if (cur === 0x2a) {
                    this.execStarPending = true;
                    continue;
                }
            }

            if (cur === 0x27 || cur === 0x22 || cur === 0x60) {
                this.emitByte(cur, out);
                this.state = "quote";
                this.quoteChar = cur;
                this.quoteEscaped = false;
                this.quoteMaybeDouble = false;
                continue;
            }

            if (cur === 0x23) {
                this.emitByte(cur, out);
                this.state = "line_comment";
                continue;
            }

            if (cur === 0x2d) {
                this.pending = [0x2d];
                this.state = "dash_pending";
                continue;
            }

            if (!this.inExecComment && cur === 0x2f) {
                this.pending = [0x2f];
                this.state = "slash_pending";
                continue;
            }

            if ((cur === 0x44 || cur === 0x64) && (this.prevByte < 0 || !isWordOrDollar(this.prevByte))) {
                this.pending = [cur];
                this.state = "maybe_definer";
                continue;
            }

            this.emitByte(cur, out);
        }
    }
}

export function createDefinerStripTransform(): TransformStream<Uint8Array, Uint8Array> {
    const stripper = new DefinerStripper();
    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            const out = stripper.push(chunk);
            if (out.byteLength > 0) controller.enqueue(out);
        },
        flush(controller) {
            const out = stripper.finish();
            if (out.byteLength > 0) controller.enqueue(out);
        },
    });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

/** Strip DEFINER clauses from mysqldump output safely without corrupting queries with asterisks or binary bytes. */
export function stripDefiners(sql: string): string;
export function stripDefiners(sql: Uint8Array): Uint8Array;
export function stripDefiners(sql: string | Uint8Array): string | Uint8Array {
    if (typeof sql === "string") {
        const encoded = new TextEncoder().encode(sql);
        const cleaned = stripDefiners(encoded);
        return new TextDecoder().decode(cleaned);
    }
    const stripper = new DefinerStripper();
    const head = stripper.push(sql);
    const tail = stripper.finish();
    return tail.byteLength === 0 ? head : concatBytes([head, tail]);
}
