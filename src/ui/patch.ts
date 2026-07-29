/**
 * Apply a freshly built tree to the mounted one by difference (§47).
 *
 * `render()` still builds the whole tree every paint. This walks that tree
 * against what is already in the document and applies only what changed, so a
 * repaint no longer destroys and recreates every node the player is touching.
 * Four shipped bugs came from that churn: the idler thrash (§36), the scroll
 * jump (§37), swallowed clicks at 2× (§39), and a monster chip destroyed
 * between `pointerup` and `click`.
 *
 * The reason this is sound where memoising was not (§47.2): there is no state
 * to enumerate. The comparison *is* the state. A missed repaint is impossible
 * because nothing is ever skipped on the strength of a signature — the tree is
 * built unconditionally and compared in full. The worst a bug in here can do is
 * too much work, not stale UI.
 */

/**
 * Attributes that identify a node across paints, so a list that reorders moves
 * nodes instead of rewriting them.
 *
 * `data-floor`+`data-room` and `data-landing`+`data-slot` are composite and
 * fall out of concatenating in order. Everything here is *identity* — a def id,
 * a coordinate, a uid — never a value that changes with state. A dynamic
 * attribute in this list would read as "different node" and force a replace,
 * which is the one thing keys exist to avoid.
 */
const KEY_ATTRS = [
  'data-uid', 'data-mob', 'data-trap', 'data-floor', 'data-room',
  'data-landing', 'data-slot', 'data-a',
] as const;

/**
 * Event handlers are assigned as `on*` properties, never `addEventListener`, so
 * carrying them onto a reused node is one assignment and there is nothing to
 * leak or double-bind. `attachDrag` was converted to `onpointerdown` for this
 * reason — a listener added with `addEventListener` cannot be copied across,
 * and would have survived on a reused node with a stale payload closure.
 *
 * Anything added to the UI with a handler not in this list will keep working on
 * first paint and then go dead when its node is reused. Add it here.
 */
const HANDLER_PROPS = [
  'onclick', 'onpointerdown', 'onpointerup', 'onpointermove',
  'oninput', 'onchange', 'onkeydown', 'onsubmit', 'onwheel',
] as const;

type Handlers = Record<string, unknown>;

function keyOf(node: Node): string | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const e = node as Element;
  let key = '';
  for (const attr of KEY_ATTRS) {
    const v = e.getAttribute(attr);
    if (v !== null) key += `${attr}=${v};`;
  }
  return key || null;
}

/** Can `mounted` be reused as `next`, or must it be replaced outright? */
function sameShape(mounted: Node, next: Node): boolean {
  if (mounted.nodeType !== next.nodeType) return false;
  if (mounted.nodeType !== Node.ELEMENT_NODE) return true;
  return (mounted as Element).tagName === (next as Element).tagName;
}

function patchNode(mounted: Node, next: Node): void {
  if (mounted.nodeType !== Node.ELEMENT_NODE) {
    if (mounted.nodeValue !== next.nodeValue) mounted.nodeValue = next.nodeValue;
    return;
  }
  const a = mounted as HTMLElement;
  const b = next as HTMLElement;

  for (const attr of Array.from(b.attributes)) {
    if (a.getAttribute(attr.name) !== attr.value) a.setAttribute(attr.name, attr.value);
  }
  // Removals in a second pass: mutating while iterating a live NamedNodeMap
  // skips entries.
  for (const attr of Array.from(a.attributes)) {
    if (!b.hasAttribute(attr.name)) a.removeAttribute(attr.name);
  }

  const ha = a as unknown as Handlers;
  const hb = b as unknown as Handlers;
  for (const prop of HANDLER_PROPS) {
    if (ha[prop] !== hb[prop]) ha[prop] = hb[prop];
  }

  patch(a, b);
}

/**
 * Reconcile `parent`'s children against `next`'s children.
 *
 * `next` is consumed: nodes with no counterpart are moved out of it and into
 * the document, which is why the caller may not reuse the tree afterwards.
 *
 * Unkeyed nodes match by a *forward scan* rather than strict position, so one
 * unmatched node does not poison the rest of the list. That is not theoretical:
 * `followAction` inserts an off-screen badge into the topbar after paint (§37),
 * a node that exists in the document but never in the built tree. Strict
 * position would fail on it and rebuild every sibling after it, every frame,
 * for the whole time the raid is off screen. The scan steps over it, matches
 * the real children, and it falls out as a leftover — which is correct, because
 * `followAction` re-adds it from fresh measurements straight after.
 */
export function patch(parent: Node, next: Node): void {
  const olds: (Node | null)[] = Array.from(parent.childNodes);
  const nexts = Array.from(next.childNodes);

  const byKey = new Map<string, number>();
  olds.forEach((node, i) => {
    const k = keyOf(node!);
    if (k !== null && !byKey.has(k)) byKey.set(k, i);
  });

  // Pass 1: decide what each incoming node reuses, claiming as we go. Keyed and
  // unkeyed draw from disjoint pools — the scan skips keyed nodes — so a keyed
  // node is never consumed by a positional match that happened to reach it.
  const reuse: (Node | null)[] = [];
  let scan = 0;
  for (const nx of nexts) {
    const k = keyOf(nx);
    let found = -1;
    if (k !== null) {
      const i = byKey.get(k);
      if (i !== undefined && olds[i] && sameShape(olds[i]!, nx)) found = i;
    } else {
      for (let i = scan; i < olds.length; i++) {
        const o = olds[i];
        if (o && keyOf(o) === null && sameShape(o, nx)) { found = i; break; }
      }
    }
    if (found >= 0) {
      reuse.push(olds[found]!);
      olds[found] = null;
      if (k === null) scan = found + 1;
    } else {
      reuse.push(null);
    }
  }

  // Pass 2: put the children in the order `nexts` asks for. `cursor` walks the
  // mounted list; anything it is still sitting on at the end was not claimed.
  let cursor = parent.firstChild;
  for (let i = 0; i < nexts.length; i++) {
    const mounted = reuse[i];
    if (mounted) {
      if (mounted === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(mounted, cursor);
      patchNode(mounted, nexts[i]!);
    } else {
      parent.insertBefore(nexts[i]!, cursor);
    }
  }

  for (const leftover of olds) if (leftover) parent.removeChild(leftover);
}
