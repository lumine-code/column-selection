const { CompositeDisposable, Disposable } = require("lumine");

module.exports = {
  activate() {
    this.editor = null;
    this.editorDisposable = null;
    this.context = false;
    this.switch = null;
    this.savedSelections = [];
    this.mouseStart = null;
    this.mouseEnd = null;
    this.dragging = false;
    this.autoscrollToken = null;
    this.selecting = false;
    this.stickyFlag = false;
    this.pickerFlag = false;
    this.atomicTabs = undefined;
    this.lastMoveEvent = null;

    this.disposables = new CompositeDisposable(
      lumine.config.observe("editor.multiCursorOnClick", (value) => {
        this.multiCursorOnClick = value;
      }),
      lumine.config.observe("column-selection.mouseButton", (value) => {
        this.mouseButton = value;
      }),
      lumine.config.observe("column-selection.selectKey", (value) => {
        this.selectKey = value;
      }),
      lumine.config.onDidChange("column-selection.statusBar", ({ newValue }) => {
        newValue ? this.activateStatusBar() : this.deactivateStatusBar();
      }),
      lumine.commands.add("lumine-workspace", {
        "column-selection:sticky": {
          description: "Keep column selection on, without holding the modifier.",
          didDispatch: () => this.toggleSticky(),
        },
        "column-selection:picker": {
          description: "Turn on the pointer mode that drags out a column block.",
          didDispatch: () => this.togglePicker(),
        },
      }),
    );

    // Its own property: this module is a singleton, so wrapping the method in
    // place left every later activation wrapping the previous activation's
    // wrapper, and the method itself unreachable after the first.
    //
    // Only the high-frequency callers go through it. A gesture whose whole
    // update is a single call -- a sticky click, the picker's second click --
    // calls the method, because a leading-edge throttle already spent on a
    // mousemove earlier in the same frame would swallow it.
    this.throttledSelectBox = throttleWithAnimationFrame(this.selectBox.bind(this));
    this.registerEventListener(window, "mousedown", this.mouseDown.bind(this), true);
    this.registerEventListener(window, "mouseup", this.mouseUp.bind(this), true);
    this.registerEventListener(window, "mousemove", this.mouseMove.bind(this), true);
    this.registerEventListener(window, "contextmenu", this.contextMenu.bind(this), true);
    this.registerEventListener(window, "scroll", this.scrollEvent.bind(this), true);
  },

  deactivate() {
    this.restoreEditorPresentation();
    this.finishGesture();
    this.deactivateStatusBar();
    this.disposables.dispose();
  },

  registerEventListener(element, type, listener, options) {
    element.addEventListener(type, listener, options);
    this.disposables.add(
      new Disposable(() => element.removeEventListener(type, listener, options)),
    );
  },

  toggleSticky() {
    this.stickyFlag = !this.stickyFlag;
    this.switch?.updateSticky();
  },

  togglePicker() {
    this.pickerFlag = this.pickerFlag ? false : true;
    if (!this.pickerFlag) {
      this.restoreEditorPresentation();
      this.finishGesture();
    }
    this.switch?.updatePicker();
  },

  findEditor(event) {
    if (!this.editor) {
      const element = event.target.closest?.("lumine-text-editor");
      if (element) this.setEditor(element.getModel());
    }
    return this.editor;
  },

  // A tab can close mid-gesture. `did-destroy` is emitted after the display
  // layer is already gone, and the emitter dispatches with a bare call, so this
  // handler only drops what points at the editor: restoring its presentation
  // from here would throw inside the emit and abort the rest of its teardown.
  // The two presentation flags are cleared by hand for the same reason -- both
  // of their restore paths read `this.editor`, and leaving them set would carry
  // this editor's state onto the next one.
  setEditor(editor) {
    this.editor = editor;
    this.editorDisposable = editor.onDidDestroy(() => {
      this.selecting = false;
      this.atomicTabs = undefined;
      this.resetGesture();
    });
  },

  shouldStartSelection(event) {
    if (this.stickyFlag && event.which === 1) return true;
    if (!this.mouseButton || event.which !== this.mouseButton) return false;

    switch (this.selectKey) {
      case 0:
        return true;
      case 1:
        return event.shiftKey;
      case 2:
        return event.altKey;
      case 3:
        return event.ctrlKey;
      default:
        return false;
    }
  },

  // A screen column counts characters; a pixel offset does not. A line can
  // carry width that no column owns — an inlay hint's label, a double-width
  // glyph, a fallback font for one character — so dividing by the character
  // width names a column to the right of the one under the pointer. Ask the
  // renderer, which measures what it drew, and count characters only past the
  // end of the line, where there is nothing rendered left to measure.
  //
  // Both corners of the box are converted this way and nothing else is: the
  // box remains a rectangle in column space, so the rows between the corners
  // stay free however far the drag runs, and a hint arriving mid-drag cannot
  // change which characters the gesture selects.
  screenPositionForMouseEvent(event) {
    const { component } = this.editor;
    const pixelPosition = component.pixelPositionForMouseEvent(event);
    let position;
    try {
      position = component.screenPositionForPixelPosition(pixelPosition);
    } catch {
      return null;
    }
    const { row } = position;
    const lineLength = this.editor.lineLengthForScreenRow(row);
    if (position.column < lineLength) return { row, column: position.column };
    const past = this.columnsPastEndOfLine(row, lineLength, pixelPosition.left);
    return { row, column: lineLength + past };
  },

  // The renderer clamps a pixel position to the end of its line, so without
  // this the box would collapse onto ragged line ends. Measuring that end is
  // the whole cost, so take the renderer's cached position first — it keeps
  // every position it has measured until the styles change — and pay for a
  // measuring update only on the first visit to a line.
  columnsPastEndOfLine(row, lineLength, left) {
    const charWidth = this.editor.getDefaultCharWidth();
    if (!charWidth) return 0;
    const { component } = this.editor;
    const endLeft =
      component.pixelLeftForRowAndColumn(row, lineLength) ??
      component.pixelPositionForScreenPosition({ row, column: lineLength }).left ??
      lineLength * charWidth;
    return Math.max(0, Math.round((left - endLeft) / charWidth));
  },

  disableAtomicSoftTabs() {
    if (this.editor && this.atomicTabs === undefined) {
      this.atomicTabs = this.editor.hasAtomicSoftTabs();
      if (this.atomicTabs) this.editor.displayLayer.atomicSoftTabs = false;
    }
  },

  restoreAtomicSoftTabs() {
    if (this.editor && this.atomicTabs !== undefined) {
      if (this.atomicTabs) this.editor.displayLayer.atomicSoftTabs = true;
      this.atomicTabs = undefined;
    }
  },

  mouseDown(event) {
    if (this.pickerFlag) {
      if (!this.findEditor(event)) return;
      this.disableAtomicSoftTabs();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.stickyFlag && event.which === 1 && event.shiftKey) {
      if (!this.findEditor(event)) return;
      if (!this.mouseStart || this.editor.getSelections().length === 1) {
        this.saveSelections(true);
        this.mouseStart = this.editor.getLastCursor().getScreenPosition();
      }
      this.disableAtomicSoftTabs();
      this.selectBox(event);
      event.stopPropagation();
      return;
    }

    if (!this.shouldStartSelection(event) || !this.findEditor(event)) return;

    this.saveSelections(this.multiCursorOnClick && event.ctrlKey);
    this.dragging = true;
    this.lastMoveEvent = null;
    this.mouseEnd = null;
    this.disableAtomicSoftTabs();
    this.mouseStart = this.screenPositionForMouseEvent(event);
    if (!this.mouseStart) {
      this.restoreEditorPresentation();
      this.resetGesture();
      return;
    }
    this.autoscrollOnMouseDrag();
  },

  mouseUp(event) {
    // Above the picker branch, which returns: this flag is the only thing that
    // stops the animation-frame loop, and the button has been released whether
    // the picker took the event or not.
    this.dragging = false;

    if (this.pickerFlag) {
      this.finishPickerClick(event);
      return;
    }

    if (this.editor) {
      this.restoreEditorPresentation();
      this.finishGesture();
      event.preventDefault();
      event.stopPropagation();
    }
  },

  finishPickerClick(event) {
    if (!this.findEditor(event)) {
      this.togglePicker();
      return;
    }

    if (event.which === 1) {
      if (this.pickerFlag === 1) {
        this.saveSelections(this.multiCursorOnClick && event.ctrlKey);
        this.mouseEnd = this.screenPositionForMouseEvent(event);
        if (this.mouseEnd) this.selectBox();
        this.togglePicker();
      } else {
        this.pickerFlag = 1;
        this.mouseStart = this.screenPositionForMouseEvent(event);
      }
    } else if (event.which === 3) {
      this.context = true;
      this.togglePicker();
    }

    event.preventDefault();
    event.stopPropagation();
  },

  mouseMove(event) {
    if (!this.editor || this.pickerFlag) return;
    this.removeCursorLineDecoration();
    this.addSelectionClass();
    this.context = true;
    this.lastMoveEvent = event;
    this.throttledSelectBox(event);
    event.preventDefault();
    event.stopPropagation();
  },

  scrollEvent() {
    if (this.editor && !this.pickerFlag && this.lastMoveEvent) {
      this.throttledSelectBox(this.lastMoveEvent);
    }
  },

  autoscrollOnMouseDrag() {
    // The token is both "a loop is running" and which loop it is: a callback
    // queued by a gesture that has since ended finds a different token and
    // stops, so a press landing in that same frame starts one loop rather than
    // joining a second one to it.
    if (this.autoscrollToken) return;
    this.autoscrollToken = {};
    this.scheduleAutoscrollFrame(this.autoscrollToken);
  },

  // Recurses here rather than through the guarded entry point above, which
  // would see its own token and stop the loop after a single frame.
  scheduleAutoscrollFrame(token) {
    window.requestAnimationFrame(() => {
      if (token !== this.autoscrollToken) return;
      if (!this.editor || !this.dragging) {
        this.autoscrollToken = null;
        return;
      }
      if (this.lastMoveEvent) {
        this.editor.component.autoscrollOnMouseDrag(this.lastMoveEvent);
      }
      this.scheduleAutoscrollFrame(token);
    });
  },

  contextMenu(event) {
    if (!this.context) return;
    this.context = false;
    event.preventDefault();
    event.stopPropagation();
  },

  selectBox(event) {
    if (!this.editor) return;
    if (event) {
      const nextPosition = this.screenPositionForMouseEvent(event);
      if (!nextPosition) return;
      if (
        this.mouseEnd &&
        nextPosition.row === this.mouseEnd.row &&
        nextPosition.column === this.mouseEnd.column
      ) {
        return;
      }
      this.mouseEnd = nextPosition;
    }
    if (!this.mouseStart || !this.mouseEnd) return;

    const ranges = this.rangesForBox(this.mouseStart, this.mouseEnd);
    if (!ranges.length) return;
    this.updateSelections(ranges, this.mouseEnd.column < this.mouseStart.column);

    // The writes no longer scroll, and only the last one ever did. A drag has
    // the animation-frame loop to follow the pointer past the editor's edge; a
    // sticky click and the picker's second click have nothing else, so the
    // corner that moved is brought into view here, once. The pointer is clamped
    // to the scroll container, so this is a no-op unless that corner sits
    // within the autoscroll margin of an edge -- which is what the scrolling it
    // replaces did too.
    if (!this.dragging) this.editor.scrollToScreenPosition(this.mouseEnd);
  },

  rangesForBox(start, end) {
    const zeroRanges = [];
    const realRanges = [];
    const reversed = end.column < start.column;
    const ascending = start.row <= end.row;

    for (let row = start.row; ascending ? row <= end.row : row >= end.row;) {
      const range = this.editor.bufferRangeForScreenRange([
        [row, start.column],
        [row, end.column],
      ]);
      if (!range.isEmpty()) {
        realRanges.push(range);
      } else {
        let pointStart = this.editor.screenPositionForBufferPosition(range.start);
        let pointEnd = this.editor.screenPositionForBufferPosition(range.end);
        if (reversed) [pointStart, pointEnd] = [pointEnd, pointStart];
        if (pointStart.column === start.column || pointEnd.column === end.column) {
          if (pointStart.column === 0 && pointEnd.column === 0) zeroRanges.push(range);
          else realRanges.push(range);
        }
      }
      ascending ? row++ : row--;
    }

    return realRanges.length ? realRanges : zeroRanges;
  },

  updateSelections(ranges, reversed) {
    const selections = this.editor.selections;
    const required = ranges.length + this.savedSelections.length;
    // One batch rather than one destroy at a time: a fast flick back up the
    // buffer sheds thousands of rows in a single frame, and removing them
    // individually rescans both of the editor's lists for each one.
    this.editor.destroySelections(selections.slice(required));

    // No write scrolls. Every added row asked the component to scroll to it and
    // the component keeps one pending request, so all but the last were
    // computed and thrown away; the gesture arranges its own scrolling instead,
    // at the tail of selectBox.
    //
    // Folds are preserved at every write. The box's corners are recorded in
    // screen coordinates, so unfolding a region mid-gesture would move the row
    // space out from under the origin the gesture started from -- and the fold
    // pass is not free even on a buffer that has none, because it asks the
    // marker index twice per write before it can find that out.
    //
    // Merging is suppressed for the whole gesture and run once at its end. The
    // sweep after every write walks every selection and asks each neighbouring
    // pair for its buffer range, which is the part of this that grows with the
    // box -- and it never has anything to merge, because one range per screen
    // row cannot intersect its neighbours. `avoidMergingSelections` still sets
    // the suppression that keeps `addSelection` from running its own sweep per
    // added row, which is the part that must not be dropped.
    this.editor.avoidMergingSelections(() => {
      this.savedSelections.forEach((saved, index) => {
        if (selections[index]) {
          selections[index].setBufferRange(saved.range, {
            reversed: saved.reversed,
            preserveFolds: true,
            autoscroll: false,
          });
        } else {
          this.editor.addSelectionForBufferRange(saved.range, {
            reversed: saved.reversed,
            preserveFolds: true,
            autoscroll: false,
          });
        }
      });
      ranges.forEach((range, index) => {
        const selection = selections[index + this.savedSelections.length];
        if (selection) {
          selection.setBufferRange(range, { reversed, preserveFolds: true, autoscroll: false });
        } else {
          this.editor.addSelectionForBufferRange(range, {
            reversed,
            preserveFolds: true,
            autoscroll: false,
          });
        }
      });
    });
  },

  saveSelections(preserve) {
    this.savedSelections = preserve
      ? this.editor.selections.map((selection) => ({
          range: selection.getBufferRange(),
          reversed: selection.isReversed(),
        }))
      : [];
  },

  addSelectionClass() {
    if (!this.editor || this.selecting) return;
    this.selecting = true;
    this.editor.getElement().classList.add("column-selection");
  },

  removeSelectionClass() {
    if (!this.editor || !this.selecting) return;
    this.selecting = false;
    this.editor.getElement().classList.remove("column-selection");
  },

  removeCursorLineDecoration() {
    if (!this.editor || this.selecting || !this.editor.cursorLineDecorations) return;
    for (const decoration of this.editor.cursorLineDecorations) decoration.destroy();
  },

  restoreEditorPresentation() {
    if (!this.editor) return;
    if (this.selecting) this.editor.decorateCursorLine();
    this.removeSelectionClass();
    this.restoreAtomicSoftTabs();
  },

  // Every write during a gesture runs with merging suppressed, so the overlaps
  // a gesture can create -- a sticky anchor sitting inside its own first row, a
  // preserved selection the box has grown over -- are resolved once, here.
  finishGesture() {
    // A fresh literal: `Selection::merge` writes into the options object it is
    // handed, and the sweep hands the same one to every merge it makes.
    if (this.editor?.isAlive()) this.editor.mergeIntersectingSelections({ preserveFolds: true });
    this.resetGesture();
  },

  resetGesture() {
    this.editorDisposable?.dispose();
    this.editorDisposable = null;
    this.autoscrollToken = null;
    this.editor = null;
    this.mouseStart = null;
    this.mouseEnd = null;
    this.lastMoveEvent = null;
    this.savedSelections = [];
    this.dragging = false;
  },

  consumeStatusBar(statusBar) {
    this.statusBar = statusBar;
    if (lumine.config.get("column-selection.statusBar")) this.activateStatusBar();
  },

  activateStatusBar() {
    if (!this.statusBar || this.switch) return;
    this.switch = this.createSwitch();
    this.switch.updateSticky();
    this.switch.updatePicker();
    // Editor-mode band, see packages/status-bar/README.md.
    this.statusBarTile = this.statusBar.addRightTile({
      item: this.switch,
      priority: 220,
    });
    const keyBindingTarget = lumine.views.getView(lumine.workspace);
    this.tooltipDisposable = lumine.tooltips.addComposite(this.switch, [
      {
        title: () => {
          if (this.pickerFlag) return "Picker mode is enabled";
          if (this.stickyFlag) return "Sticky column mode is enabled";
        },
      },
      {
        title: "Toggle sticky mode",
        keyBindingExtra: "LMB",
        keyBindingCommand: "column-selection:sticky",
        keyBindingTarget,
      },
      {
        title: "Toggle picker mode",
        keyBindingExtra: "RMB",
        keyBindingCommand: "column-selection:picker",
        keyBindingTarget,
      },
    ]);
  },

  deactivateStatusBar() {
    this.tooltipDisposable?.dispose();
    this.tooltipDisposable = null;
    this.statusBarTile?.destroy();
    this.statusBarTile = null;
    this.switch?.remove();
    this.switch = null;
  },

  createSwitch() {
    const element = document.createElement("status-bar-tile");
    element.classList.add("column-selection-icon");
    const icon = document.createElement("span");
    icon.classList.add("icon", "is-icon-only", "icon-three-bars");
    element.appendChild(icon);
    element.onmouseup = (event) => {
      if (event.which === 1) this.toggleSticky();
      else if (event.which === 3) this.togglePicker();
    };
    element.updateSticky = () => icon.classList.toggle("sticky", this.stickyFlag);
    element.updatePicker = () => icon.classList.toggle("picker", Boolean(this.pickerFlag));
    return element;
  },
};

function throttleWithAnimationFrame(callback) {
  let pending = false;
  return (...args) => {
    if (pending) return;
    callback(...args);
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
    });
  };
}
