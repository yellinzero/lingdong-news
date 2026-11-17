export type Label = string | (() => string);
const bindings = new WeakMap<Node, Map<string, () => void>>();
function bind(node: Node, slot: string, value: Label, apply: (value: string) => void) {
  let slots = bindings.get(node);
  if (typeof value === 'function') {
    if (!slots) bindings.set(node, slots = new Map());
    slots.set(slot, () => apply(value()));
    apply(value());
  } else {
    slots?.delete(slot);
    apply(value);
  }
}
export function localizedText(node: Node, value: Label): void {
  let text: Text;
  if (node.nodeType === Node.TEXT_NODE) text = node as Text;
  else if (node.childNodes.length === 1 && node.firstChild?.nodeType === Node.TEXT_NODE) text = node.firstChild as Text;
  else { text = document.createTextNode(''); node.textContent = ''; node.appendChild(text); }
  bind(text, 'text', value, copy => { if (text.data !== copy) text.data = copy; });
}
export function localizedNode(value: Label): Text {
  const node = document.createTextNode(''); localizedText(node, value); return node;
}
export function localizedAttr(node: Element, name: string, value: Label): void {
  bind(node, name, value, copy => { if (node.getAttribute(name) !== copy) node.setAttribute(name, copy); });
}
// Refresh only explicitly bound interface copy. Inputs, news and user text are
// untouched, so focus, selection, draft keys and in-flight actions survive.
export function refreshTranslations(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  let node: Node | null = root;
  while (node) { bindings.get(node)?.forEach(update => update()); node = walker.nextNode(); }
}
