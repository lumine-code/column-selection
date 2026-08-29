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
    this.boxCache = null;
    this.applyingSelections = false;

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
    this.throttledSelectBox = throttleWithAnimationFrame(
      this.selectBox.bind(this),
      () => this.editorElement()?.ownerDocument.defaultView || globalThis.window,
    );
    this.boundWindows = new WeakSet();
    this.bindWindow(globalThis.window);
    this.disposables.add(
      lumine.workspace.addWindowSurfaceTransitionObserver((context) => {
        if (!lumine.workspace.isTextEditor(context.item)) return;
        if (this.editor === context.item) {
          this.restoreEditorPresentation();
          this.finishGesture();
        }
        const finish = (transitionContext) => this.bindWindow(transitionContext.to.window);
        return {
          commit: finish,
          rollback: (transitionContext) => this.bindWindow(transitionContext.from.window),
        };
      }),
    );
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

  bindWindow(domWindow) {
    if (!domWindow || this.boundWindows.has(domWindow)) return;
    this.boundWindows.add(domWindow);
    this.registerEventListener(domWindow, "mousedown", this.mouseDown.bind(this), true);
    this.registerEventListener(domWindow, "mouseup", this.mouseUp.bind(this), true);
    this.registerEventListener(domWindow, "mousemove", this.mouseMove.bind(this), true);
    this.registerEventListener(domWindow, "contextmenu", this.contextMenu.bind(this), true);
    this.registerEventListener(domWindow, "scroll", this.scrollEvent.bind(this), true);
  },

  editorElement() {
    return this.editor ? lumine.views.getView(this.editor) : null;
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
  // The other subscriptions are what make the box cache trustworthy: anything
  // that moves text or selections out from under the previous frame's answer
  // drops it, and the next frame walks the whole box again. That includes the
  // editor itself, which merges intersecting selections on every display-layer
  // change and can destroy this package's rows mid-gesture. The selection
  // events also fire for this package's own writes, which is what
  // `applyingSelections` filters back out -- without it, every row a frame
  // added would invalidate the cache that added it. All of this lives only
  // from mousedown to resetGesture, so an idle editor pays nothing.
  setEditor(editor) {
    this.editor = editor;
    const invalidate = () => {
      this.boxCache = null;
    };
    const invalidateUnlessOwn = () => {
      if (!this.applyingSelections) this.boxCache = null;
    };
    this.editorDisposable = new CompositeDisposable(
      editor.onDidDestroy(() => {
        this.selecting = false;
        this.atomicTabs = undefined;
        this.resetGesture();
      }),
      editor.displayLayer.onDidChange(invalidate),
      editor.displayLayer.onDidReset(invalidate),
      editor.onDidAddSelection(invalidateUnlessOwn),
      editor.onDidRemoveSelection(invalidateUnlessOwn),
      editor.onDidChangeSelectionRange(invalidateUnlessOwn),
    );
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
    const domWindow = this.editorElement()?.ownerDocument.defaultView || globalThis.window;
    domWindow.requestAnimationFrame(() => {
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

    const { ranges, firstDirtyIndex } = this.boxForGesture(this.mouseStart, this.mouseEnd);
    if (!ranges.length) return;
    this.updateSelections(ranges, this.mouseEnd.column < this.mouseStart.column, firstDirtyIndex);

    // The writes no longer scroll, and only the last one ever did. A drag has
    // the animation-frame loop to follow the pointer past the editor's edge; a
    // sticky click and the picker's second click have nothing else, so the
    // corner that moved is brought into view here, once. The pointer is clamped
    // to the scroll container, so this is a no-op unless that corner sits
    // within the autoscroll margin of an edge -- which is what the scrolling it
    // replaces did too.
    if (!this.dragging) this.editor.scrollToScreenPosition(this.mouseEnd);
  },

  // The box between two frames differs only at its moving corner: the anchor
  // is frozen at mousedown, the throttle admits one update per frame, and the
  // autoscroll loop shifts the pointer a handful of rows at a time -- so
  // almost every frame is the previous box, a little longer or a little
  // shorter. Walking every row anyway is what made a drag quadratic: frame k
  // paid for k rows, and the loop kept the frames coming. The cache keeps what
  // the previous frame computed, so a frame that only moved the end pays for
  // the rows the pointer crossed and nothing else.
  //
  // Reuse is allowed only while everything that fed the previous answer still
  // stands: same anchor, same columns, the end still on the same side of the
  // anchor, and the editor still holding exactly the selections the previous
  // frame wrote. The subscriptions in setEditor drop the cache when text or
  // selections change behind the gesture's back; the length comparison is a
  // last line against a mutation arriving where those subscriptions cannot
  // see it. Everything else -- a moved anchor, a changed column, a flipped
  // direction, an emptied cache -- walks the whole box again, so the delta
  // never has to be cleverer than "the same box, longer or shorter".
  boxForGesture(start, end) {
    const cache = this.boxCache;
    if (
      cache &&
      cache.startRow === start.row &&
      cache.startColumn === start.column &&
      cache.endColumn === end.column &&
      cache.ascending === start.row <= end.row &&
      this.editor.selections.length === this.savedSelections.length + cache.ranges.length
    ) {
      const firstDirtyIndex = this.moveBoxEnd(cache, end.row);
      if (firstDirtyIndex !== null) {
        cache.endRow = end.row;
        return { ranges: cache.ranges, firstDirtyIndex };
      }
    }

    const walked = this.computeBox(start, end);
    // An empty box leaves the previous frame's selections standing, so there
    // is nothing on screen for a cache to describe; the next frame starts
    // over rather than measuring a delta against rows it never applied.
    this.boxCache = walked.ranges.length
      ? {
          startRow: start.row,
          startColumn: start.column,
          endRow: end.row,
          endColumn: end.column,
          ascending: start.row <= end.row,
          bucket: walked.bucket,
          ranges: walked.ranges,
          rows: walked.rows,
        }
      : null;
    return { ranges: walked.ranges, firstDirtyIndex: 0 };
  },

  // Grows or trims the cached box to a new end row, in place. Returns the
  // first index updateSelections must write -- everything below it is already
  // on screen -- or null when the cache cannot answer and the caller has to
  // walk the whole box again.
  //
  // Two cases give up on purpose. A real range arriving while the cache holds
  // bare cursors flips the box's bucket, retroactively discarding rows that
  // were kept; that is the walk's global decision and only the walk makes it.
  // And trimming to nothing means every kept row is gone, at which point rows
  // the walk discarded on the way out may be the box again.
  moveBoxEnd(cache, endRow) {
    const { ranges, rows } = cache;

    if (cache.ascending ? endRow > cache.endRow : endRow < cache.endRow) {
      const firstDirtyIndex = ranges.length;
      const step = cache.ascending ? 1 : -1;
      const from = cache.endRow + step;
      const entries = this.editor.bufferRangesForScreenColumnBlock(
        Math.min(from, endRow),
        Math.max(from, endRow),
        cache.startColumn,
        cache.endColumn,
      );
      if (step === -1) entries.reverse();

      let row = from;
      for (const { bufferRange, screenColumn } of entries) {
        const kind = this.classifyBoxRange(
          bufferRange,
          screenColumn,
          cache.startColumn,
          cache.endColumn,
        );
        if (kind === "real" && cache.bucket === "zero") return null;
        if (kind === cache.bucket) {
          ranges.push(bufferRange);
          rows.push(row);
        }
        row += step;
      }
      return firstDirtyIndex;
    }

    while (rows.length) {
      const last = rows[rows.length - 1];
      if (cache.ascending ? last <= endRow : last >= endRow) break;
      rows.pop();
      ranges.pop();
    }
    return ranges.length ? ranges.length : null;
  },

  // One walk, row by row from the anchor to the moving corner. Every row gets
  // one of three fates -- a real range, a bare cursor at column zero, or
  // nothing -- and whichever bucket wins is returned with the screen row
  // beside each range, so the cache can trim from the tail later. Translation
  // stays in this loop and judgement stays in classifyBoxRange, so a bulk
  // screen-to-buffer API could feed the same judgement one day without
  // restructuring anything above it.
  computeBox(start, end) {
    const zero = { bucket: "zero", ranges: [], rows: [] };
    const real = { bucket: "real", ranges: [], rows: [] };
    const ascending = start.row <= end.row;
    const step = ascending ? 1 : -1;

    const entries = this.editor.bufferRangesForScreenColumnBlock(
      Math.min(start.row, end.row),
      Math.max(start.row, end.row),
      start.column,
      end.column,
    );
    if (!ascending) entries.reverse();

    let row = start.row;
    for (const { bufferRange, screenColumn } of entries) {
      const kind = this.classifyBoxRange(bufferRange, screenColumn, start.column, end.column);
      if (kind === "real") {
        real.ranges.push(bufferRange);
        real.rows.push(row);
      } else if (kind === "zero") {
        zero.ranges.push(bufferRange);
        zero.rows.push(row);
      }
      row += step;
    }

    // Rows with content win: a column of bare cursors is only the box when no
    // row in it has anything to select.
    return real.ranges.length ? real : zero;
  },

  // The judgement the walk and the delta both apply, one row at a time. A row
  // whose slice holds text is always part of the box. A row whose slice
  // clipped to nothing joins only when the clip landed on one of the box's own
  // columns -- otherwise the row never reached the box at all -- and a clip
  // that landed at column zero is set aside as a bare cursor, wanted only when
  // no row has text. Returns "real", "zero", or null for a row that
  // contributes nothing.
  //
  // An empty slice's two corners round-trip to the same screen column, which
  // is why one number answers what used to take two translations back: the
  // block entry carries it, and the old reversed swap exchanged equal values.
  classifyBoxRange(bufferRange, screenColumn, startColumn, endColumn) {
    if (!bufferRange.isEmpty()) return "real";
    if (screenColumn !== startColumn && screenColumn !== endColumn) return null;
    return screenColumn === 0 ? "zero" : "real";
  },

  // The walk on bare corners, kept callable on its own: the specs use it as
  // the oracle every cached gesture has to land on, precisely because it
  // knows nothing about the cache.
  rangesForBox(start, end) {
    return this.computeBox(start, end).ranges;
  },

  updateSelections(ranges, reversed, firstDirtyIndex = 0) {
    const selections = this.editor.selections;
    const required = ranges.length + this.savedSelections.length;

    // Everything in here is the package's own doing, and every write echoes
    // back through the selection events that setEditor watches. The flag is
    // how those watchers tell this frame's writes from a mutation arriving
    // from anywhere else; the finally is what keeps a throw from stranding it
    // set and silently disabling invalidation for the rest of the gesture.
    this.applyingSelections = true;
    try {
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
      // Slots below the dirty index already hold exactly these ranges -- the
      // cache vouches for them, and anything that could have moved them
      // dropped the cache and forced this index back to zero. The preserved
      // selections sit below every box slot, so a delta frame skips them too.
      this.editor.avoidMergingSelections(() => {
        if (firstDirtyIndex === 0) {
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
        }
        for (let index = firstDirtyIndex; index < ranges.length; index++) {
          const selection = selections[index + this.savedSelections.length];
          if (selection) {
            selection.setBufferRange(ranges[index], {
              reversed,
              preserveFolds: true,
              autoscroll: false,
            });
          } else {
            this.editor.addSelectionForBufferRange(ranges[index], {
              reversed,
              preserveFolds: true,
              autoscroll: false,
            });
          }
        }
      });
    } finally {
      this.applyingSelections = false;
    }
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
    this.boxCache = null;
    this.applyingSelections = false;
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

function throttleWithAnimationFrame(callback, windowProvider = () => globalThis.window) {
  let pending = false;
  return (...args) => {
    if (pending) return;
    callback(...args);
    pending = true;
    windowProvider().requestAnimationFrame(() => {
      pending = false;
    });
  };
}
