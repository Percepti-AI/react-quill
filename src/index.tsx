/*
React-Quill
https://github.com/zenoamaro/react-quill
*/

import React, { createRef } from 'react';
import { isEqual } from 'lodash-es';

import Quill, { type EmitterSource, type Range as RangeStatic, Delta, QuillOptions as QuillOptionsStatic } from 'quill';
import type DeltaStatic from 'quill-delta';

export { Quill }
export type { DeltaStatic, EmitterSource, RangeStatic, QuillOptionsStatic }

// Merged namespace hack to export types along with default object
// See: https://github.com/Microsoft/TypeScript/issues/2719
namespace ReactQuill {
  export type Value = string | DeltaStatic;
  export type Range = RangeStatic | null;

  export interface QuillOptions extends QuillOptionsStatic {
    tabIndex?: number,
  }

  export interface ReactQuillProps {
    bounds?: string | HTMLElement,
    children?: React.ReactElement<any>,
    className?: string,
    defaultValue?: Value,
    formats?: string[],
    id?: string,
    modules?: QuillOptions['modules'],
    onChange?(
      value: string,
      delta: DeltaStatic,
      source: EmitterSource,
      editor: UnprivilegedEditor,
    ): void,
    onChangeDebounced?(
      value: string,
      editorContents: Delta,
      delta: Delta,
      source: EmitterSource,
      editor: UnprivilegedEditor,
    ): void,
    debounceTimeMs?: number,
    onChangeSelection?(
      selection: Range,
      source: EmitterSource,
      editor: UnprivilegedEditor,
    ): void,
    onFocus?(
      selection: Range,
      source: EmitterSource,
      editor: UnprivilegedEditor,
    ): void,
    onBlur?(
      previousSelection: Range,
      source: EmitterSource,
      editor: UnprivilegedEditor,
    ): void,
    onKeyDown?: React.EventHandler<any>,
    onKeyPress?: React.EventHandler<any>,
    onKeyUp?: React.EventHandler<any>,
    placeholder?: string,
    preserveWhitespace?: boolean,
    readOnly?: boolean,
    style?: React.CSSProperties,
    tabIndex?: number,
    theme?: string,
    value?: Value,
  }

  export interface UnprivilegedEditor {
    getLength: Quill['getLength'];
    getText: Quill['getText'];
    getHTML: () => string;
    getSemanticHTML: Quill['getSemanticHTML'];
    getBounds: Quill['getBounds'];
    getSelection: Quill['getSelection'];
    getContents: Quill['getContents'];
  }
}

// Re-import everything from namespace into scope for comfort
import Value = ReactQuill.Value;
import Range = ReactQuill.Range;
import QuillOptions = ReactQuill.QuillOptions;
import ReactQuillProps = ReactQuill.ReactQuillProps;
import UnprivilegedEditor = ReactQuill.UnprivilegedEditor;

interface ReactQuillState {
  generation: number,
}

class ReactQuill extends React.Component<ReactQuillProps, ReactQuillState> {
  editingAreaRef = createRef<any>();

  static displayName = 'React Quill'

  /*
  Export Quill to be able to call `register`
  */
  static Quill = Quill;

  /*
  Changing one of these props should cause a full re-render and a
  re-instantiation of the Quill editor.
  */
  dirtyProps: (keyof ReactQuillProps)[] = [
    'modules',
    'formats',
    'bounds',
    'theme',
    'children',
    'debounceTimeMs',
  ]

  /*
  Changing one of these props should cause a regular update. These are mostly
  props that act on the container, rather than the quillized editing area.
  */
  cleanProps: (keyof ReactQuillProps)[] = [
    'id',
    'className',
    'style',
    'placeholder',
    'tabIndex',
    'onChange',
    'onChangeDebounced',
    'onChangeSelection',
    'onFocus',
    'onBlur',
    'onKeyPress',
    'onKeyDown',
    'onKeyUp',
  ]

  static defaultProps = {
    theme: 'snow',
    modules: {},
    readOnly: false,
  }

  state: ReactQuillState = {
    generation: 0,
  }

  /*
  The Quill Editor instance.
  */
  editor?: Quill

  /*
  Timer for debounced changes
  */
  debounceTimer?: number

  /*
  Previous content for debounced changes
  */
  prevEditorContents?: Delta | null

  /*
  Pending delta for debounced changes
  */
  pendingDelta?: Delta | null

  /*
  Tracks the internal value of the Quill editor
  */
  value: Value

  /*
  Tracks the internal selection of the Quill editor
  */
  selection: Range = null

  /*
  Used to compare whether deltas from `onChange` are being used as `value`.
  */
  lastDeltaChangeSet?: DeltaStatic

  /*
  Stores the contents of the editor to be restored after regeneration.
  */
  regenerationSnapshot?: {
    delta: DeltaStatic,
    selection: Range,
  }

  /*
  A weaker, unprivileged proxy for the editor that does not allow accidentally
  modifying editor state.
  */
  unprivilegedEditor?: UnprivilegedEditor

  constructor(props: ReactQuillProps) {
    super(props);
    const value = this.isControlled()? props.value : props.defaultValue;
    this.value = value ?? '';
  }

  validateProps(props: ReactQuillProps): void {
    if (React.Children.count(props.children) > 1) throw new Error(
      'The Quill editing area can only be composed of a single React element.'
    );

    if (React.Children.count(props.children)) {
      const child = React.Children.only(props.children);
      if (child?.type === 'textarea') throw new Error(
        'Quill does not support editing on a <textarea>. Use a <div> instead.'
      );
    }

    if (
      this.lastDeltaChangeSet &&
      props.value === this.lastDeltaChangeSet
    ) throw new Error(
      'You are passing the `delta` object from the `onChange` event back ' +
      'as `value`. You most probably want `editor.getContents()` instead. ' +
      'See: https://github.com/zenoamaro/react-quill#using-deltas'
    );
  }

  shouldComponentUpdate(nextProps: ReactQuillProps, nextState: ReactQuillState) {
    this.validateProps(nextProps);

    // If the editor hasn't been instantiated yet, or the component has been
    // regenerated, we already know we should update.
    if (!this.editor || this.state.generation !== nextState.generation) {
      return true;
    }

    // Handle value changes in-place
    if ('value' in nextProps) {
      const prevContents = this.getEditorContents();
      const nextContents = nextProps.value ?? '';

      // NOTE: Seeing that Quill is missing a way to prevent edits, we have to
      //       settle for a hybrid between controlled and uncontrolled mode. We
      //       can't prevent the change, but we'll still override content
      //       whenever `value` differs from current state.
      // NOTE: Comparing an HTML string and a Quill Delta will always trigger a
      //       change, regardless of whether they represent the same document.
      if (!this.isEqualValue(nextContents, prevContents)) {
        this.setEditorContents(this.editor, nextContents);
      }
    }

    // Handle read-only changes in-place
    if (nextProps.readOnly !== this.props.readOnly) {
      this.setEditorReadOnly(this.editor, nextProps.readOnly!);
    }

    // Clean and Dirty props require a render
    return [...this.cleanProps, ...this.dirtyProps].some((prop) => {
      return !isEqual(nextProps[prop], this.props[prop]);
    });
  }

  shouldComponentRegenerate(nextProps: ReactQuillProps): boolean {
    // Whenever a `dirtyProp` changes, the editor needs reinstantiation.
    return this.dirtyProps.some((prop) => {
      return !isEqual(nextProps[prop], this.props[prop]);
    });
  }

  componentDidMount() {
    this.instantiateEditor();
    this.setEditorContents(this.editor!, this.getEditorContents());
  }

  componentWillUnmount() {
    // Clear any debounce timer
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }
    this.destroyEditor();
  }

  componentDidUpdate(prevProps: ReactQuillProps, prevState: ReactQuillState) {
    // If we're changing one of the `dirtyProps`, the entire Quill Editor needs
    // to be re-instantiated. Regenerating the editor will cause the whole tree,
    // including the container, to be cleaned up and re-rendered from scratch.
    // Store the contents so they can be restored later.
    if (this.editor && this.shouldComponentRegenerate(prevProps)) {
      const delta = this.editor.getContents();
      const selection = this.editor.getSelection();
      this.regenerationSnapshot = {delta, selection};
      this.setState({generation: this.state.generation + 1});
      this.destroyEditor();
    }

    // The component has been regenerated, so it must be re-instantiated, and
    // its content must be restored to the previous values from the snapshot.
    if (this.state.generation !== prevState.generation) {
      const {delta, selection} = this.regenerationSnapshot!;
      delete this.regenerationSnapshot;
      this.instantiateEditor();
      const editor = this.editor!;
      editor.setContents(delta);
      postpone(() => this.setEditorSelection(editor, selection));
    }
  }

  instantiateEditor(): void {
    if (this.editor) {
      this.hookEditor(this.editor);
    } else {
      this.editor = this.createEditor(
        this.getEditingArea(),
        this.getEditorConfig()
      );
    }
  }

  destroyEditor(): void {
    if (!this.editor) return;
    this.unhookEditor(this.editor);
    // There is a buggy interaction between Quill and React 18+ strict mode, where
    // strict mode re-renders this component twice in the span of time that Quill
    // is mounting. This causes the toolbar to be rendered twice.
    // We check for and remove the toolbar if it exists, but only if we're not using
    // a custom external toolbar (which we don't want to remove).
    const toolbar = this.props.modules?.toolbar;
    const usingExternalToolbar =
      (typeof toolbar === "object" &&
        toolbar &&
        "container" in toolbar &&
        typeof toolbar.container === "string") ||
      typeof toolbar === "string";
    if (!usingExternalToolbar) {
      const leftOverToolbar = document.querySelector(".ql-toolbar");
      if (leftOverToolbar) {
        leftOverToolbar.remove();
      }
    }
    delete this.editor;
  }

  /*
  We consider the component to be controlled if `value` is being sent in props.
  */
  isControlled(): boolean {
    return 'value' in this.props;
  }

  getEditorConfig(): QuillOptions {
    return {
      bounds: this.props.bounds,
      formats: this.props.formats,
      modules: this.props.modules,
      placeholder: this.props.placeholder,
      readOnly: this.props.readOnly,
      tabIndex: this.props.tabIndex,
      theme: this.props.theme,
    };
  }

  getEditor(): Quill {
    if (!this.editor) throw new Error('Accessing non-instantiated editor');
    return this.editor;
  }

  /**
  Creates an editor on the given element. The editor will be passed the
  configuration, have its events bound,
  */
  createEditor(element: HTMLElement, config: QuillOptions) {
    const editor = new Quill(element, config);
    if (config.tabIndex != null) {
      this.setEditorTabIndex(editor, config.tabIndex);
    }
    this.hookEditor(editor);
    return editor;
  }

  hookEditor(editor: Quill) {
    // Expose the editor on change events via a weaker, unprivileged proxy
    // object that does not allow accidentally modifying editor state.
    this.unprivilegedEditor = this.makeUnprivilegedEditor(editor);
    // Using `editor-change` allows picking up silent updates, like selection
    // changes on typing.
    editor.on('editor-change', this.onEditorChange);
  }

  unhookEditor(editor: Quill) {
    editor.off('editor-change', this.onEditorChange);
  }

  getEditorContents(): Value {
    return this.value;
  }

  getEditorSelection(): Range {
    return this.selection;
  }

  /*
  True if the value is a Delta instance or a Delta look-alike.
  */
  isDelta(value: any): boolean {
    return value && value.ops;
  }

  /*
  Special comparison function that knows how to compare Deltas.
  */
  isEqualValue(value: any, nextValue: any): boolean {
    if (this.isDelta(value) && this.isDelta(nextValue)) {
      return isEqual(value.ops, nextValue.ops);
    } else {
      return isEqual(value, nextValue);
    }
  }

  /*
  Replace the contents of the editor, but keep the previous selection hanging
  around so that the cursor won't move.
  */
  setEditorContents(editor: Quill, value: Value) {
    this.value = value;
    const sel = this.getEditorSelection();
    if (typeof value === 'string') {
      editor.setContents(editor.clipboard.convert({html: value}));
    } else {
      editor.setContents(value);
    }
    if (this.prevEditorContents == null) {
      this.prevEditorContents = editor.getContents();
    }
    postpone(() => this.setEditorSelection(editor, sel));
  }

  setEditorSelection(editor: Quill, range: Range) {
    this.selection = range;
    if (range) {
      // Validate bounds before applying.
      const length = editor.getLength();
      range.index = Math.max(0, Math.min(range.index, length-1));
      range.length = Math.max(0, Math.min(range.length, (length-1) - range.index));
      editor.setSelection(range);
    }
  }

  setEditorTabIndex(editor: Quill, tabIndex: number) {
    if (editor?.scroll?.domNode) {
      (editor.scroll.domNode as HTMLElement).tabIndex = tabIndex;
    }
  }

  setEditorReadOnly(editor: Quill, value: boolean) {
    if (value) {
      editor.disable();
    } else {
      editor.enable();
    }
  }

  /*
  Returns a weaker, unprivileged proxy object that only exposes read-only
  accessors found on the editor instance, without any state-modifying methods.
  */
  makeUnprivilegedEditor(editor: Quill) {
    const e = editor;
    return {
      getHTML:         () => e.root.innerHTML,
      getSemanticHTML: e.getSemanticHTML.bind(e),
      getLength:       e.getLength.bind(e),
      getText:         e.getText.bind(e),
      getContents:     e.getContents.bind(e),
      getSelection:    e.getSelection.bind(e),
      getBounds:       e.getBounds.bind(e),
    };
  }

  getEditingArea(): HTMLElement {
    const element = this.editingAreaRef.current;
    if (!element) {
      throw new Error('Cannot find element for editing area');
    }
    if (element.nodeType === 3) {
      throw new Error('Editing area cannot be a text node');
    }
    return element as HTMLElement;
  }

  /*
  Renders an editor area, unless it has been provided one to clone.
  */
  renderEditingArea(): JSX.Element {
    const {children, preserveWhitespace} = this.props;
    const {generation} = this.state;

    const properties = {
      key: generation,
      ref: this.editingAreaRef,
    };

    if (React.Children.count(children)) {
      return React.cloneElement(
        React.Children.only(children)!,
        properties
      );
    }

    return preserveWhitespace ?
      <pre {...properties}/> :
      <div {...properties}/>;
  }

  render() {
    return (
      <div
        id={this.props.id}
        style={this.props.style}
        key={this.state.generation}
        className={`quill ${this.props.className ?? ''}`}
        onKeyPress={this.props.onKeyPress}
        onKeyDown={this.props.onKeyDown}
        onKeyUp={this.props.onKeyUp}
      >
        {this.renderEditingArea()}
      </div>
    );
  }

  onEditorChange = (
    eventName: 'text-change' | 'selection-change',
    rangeOrDelta: Range | DeltaStatic,
    oldRangeOrDelta: Range | DeltaStatic,
    source: EmitterSource,
  ) => {
    if (eventName === 'text-change') {
      this.onEditorChangeText?.(
        this.editor!.root.innerHTML,
        rangeOrDelta as DeltaStatic,
        source,
        this.unprivilegedEditor!
      );
    } else if (eventName === 'selection-change') {
      this.onEditorChangeSelection?.(
        rangeOrDelta as RangeStatic,
        source,
        this.unprivilegedEditor!
      );
    }
  };

  onEditorChangeText(
    value: string,
    delta: DeltaStatic,
    source: EmitterSource,
    editor: UnprivilegedEditor,
  ): void {
    if (!this.editor) return;

    // We keep storing the same type of value as what the user gives us,
    // so that value comparisons will be more stable and predictable.
    const nextContents = this.isDelta(this.value)
      ? editor.getContents()
      : editor.getHTML();

    if (nextContents !== this.getEditorContents()) {
      // Taint this `delta` object, so we can recognize whether the user
      // is trying to send it back as `value`, preventing a likely loop.
      this.lastDeltaChangeSet = delta;

      this.value = nextContents;
      this.props.onChange?.(value, delta, source, editor);

      // Handle debounced change if the callback exists
      if (this.props.onChangeDebounced) {
        // Clear any existing timer
        if (this.debounceTimer) {
          window.clearTimeout(this.debounceTimer);
        }

        if (this.prevEditorContents == null) {
          this.prevEditorContents = new Delta();
        }
        if (this.pendingDelta == null) {
          this.pendingDelta = new Delta();
        }
        this.pendingDelta = this.pendingDelta.compose(delta);
        // Set a new timer
        this.debounceTimer = window.setTimeout(() => {
          this.props.onChangeDebounced?.(value, this.prevEditorContents!, this.pendingDelta!, source, editor);
          this.prevEditorContents = editor.getContents();
          this.pendingDelta = null;
          this.debounceTimer = undefined;
        }, this.props.debounceTimeMs ?? 1000);
      }
    }
  }

  onEditorChangeSelection(
    nextSelection: RangeStatic,
    source: EmitterSource,
    editor: UnprivilegedEditor,
  ): void {
    if (!this.editor) return;
    const currentSelection = this.getEditorSelection();
    const hasGainedFocus = !currentSelection && nextSelection;
    const hasLostFocus = currentSelection && !nextSelection;

    if (isEqual(nextSelection, currentSelection)) return;

    this.selection = nextSelection;
    this.props.onChangeSelection?.(nextSelection, source, editor);

    if (hasGainedFocus) {
      this.props.onFocus?.(nextSelection, source, editor);
    } else if (hasLostFocus) {
      this.props.onBlur?.(currentSelection, source, editor);
    }
  }

  focus(): void {
    if (!this.editor) return;
    this.editor.focus();
  }

  blur(): void {
    if (!this.editor) return;
    this.selection = null;
    this.editor.blur();
  }
}

/*
Small helper to execute a function in the next micro-tick.
*/
function postpone(fn: (value: void) => void) {
  Promise.resolve().then(fn);
}

export default ReactQuill;
