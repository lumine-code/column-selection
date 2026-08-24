const path = require("path");

// Activate the checkout these specs live in rather than whichever copy the
// package name resolves to, which for a bundled package is the pinned one.
const packageRoot = path.join(__dirname, "..");

// The label an inlay hint draws is the case this package has to survive:
// width inside a line that belongs to no column, which is exactly what makes a
// pixel offset stop counting characters.
const HINT_CLASS = "column-selection-spec-hint";
const HINT_STYLE = `.${HINT_CLASS}::before { content: "HHHHHHHH"; }`;

describe("column-selection", () => {
  let mainModule;
  let editor;
  let element;
  let component;
  let charWidth;
  let lineHeight;
  let styleElement;

  beforeEach(async () => {
    const workspaceElement = lumine.views.getView(lumine.workspace);
    workspaceElement.style.height = "300px";
    workspaceElement.style.width = "1000px";
    jasmine.attachToDOM(workspaceElement);

    const pack = await lumine.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;

    editor = await lumine.workspace.open();
    editor.setText("0123456789\nabcdefghij\n");
    element = editor.getElement();
    component = element.getComponent();
    component.updateSync();

    charWidth = editor.getDefaultCharWidth();
    lineHeight = editor.getLineHeightInPixels();
    expect(charWidth).toBeGreaterThan(0);
  });

  afterEach(async () => {
    styleElement?.remove();
    styleElement = null;
    await lumine.packages.deactivatePackage("column-selection");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });

  // A pointer over a content pixel, in the client coordinates a real mouse
  // event carries.
  function eventAtPixel(type, { top, left }, properties = {}) {
    const linesRect = element.querySelector(".lines").getBoundingClientRect();
    return new MouseEvent(type, {
      bubbles: true,
      clientX: linesRect.left + left,
      clientY: linesRect.top + top,
      ...properties,
    });
  }

  // A pointer `offset` character widths right of where `column` is drawn,
  // which is not `column * charWidth` once the line carries a label.
  function eventAt(type, { row, column, offset = 0.5 }, properties = {}) {
    const pixel = component.pixelPositionForScreenPosition({ row, column });
    return eventAtPixel(
      type,
      { top: pixel.top + lineHeight / 2, left: pixel.left + offset * charWidth },
      properties,
    );
  }

  function leftOf(row, column) {
    return component.pixelPositionForScreenPosition({ row, column }).left;
  }

  function decorateWithHint(range) {
    styleElement = document.createElement("style");
    styleElement.textContent = HINT_STYLE;
    document.head.appendChild(styleElement);
    const marker = editor.markScreenRange(range);
    editor.decorateMarker(marker, { type: "text", class: HINT_CLASS });
    component.updateSync();
    return marker;
  }

  // A taller buffer than the default, for the specs whose box spans more rows
  // than the fixture has.
  function useLines(count) {
    editor.setText("0123456789\n".repeat(count));
    component.updateSync();
  }

  // `waitForFrames` resolves on a condition; this is the "yield N frames" form,
  // which is what the leading-edge throttle and the autoscroll loop need.
  async function waitFrames(count = 1) {
    let remaining = count;
    await waitForFrames(() => --remaining <= 0, {
      frames: count + 2,
      description: `${count} animation frames`,
    });
  }

  describe("package lifecycle", () => {
    it("activates and deactivates cleanly", async () => {
      expect(lumine.packages.isPackageActive("column-selection")).toBe(true);
      await lumine.packages.deactivatePackage("column-selection");
      expect(lumine.packages.isPackageActive("column-selection")).toBe(false);
    });

    it("re-arms the throttle instead of wrapping the last one", async () => {
      // The module object outlives a deactivation, so a throttle written over
      // the method would be the thing wrapped on the next activation.
      const method = mainModule.selectBox;
      const throttled = mainModule.throttledSelectBox;

      await lumine.packages.deactivatePackage("column-selection");
      await lumine.packages.activatePackage(packageRoot);

      expect(mainModule.selectBox).toBe(method);
      expect(mainModule.throttledSelectBox).not.toBe(throttled);
    });

    it("keeps no editor subscription after a gesture", () => {
      element.dispatchEvent(eventAt("mousedown", { row: 0, column: 2 }, { button: 2 }));
      element.dispatchEvent(eventAt("mousemove", { row: 1, column: 5 }, { button: 2 }));
      expect(mainModule.editorDisposable).toBeTruthy();

      element.dispatchEvent(eventAt("mouseup", { row: 1, column: 5 }, { button: 2 }));
      expect(mainModule.editorDisposable).toBeNull();
      expect(mainModule.editor).toBeNull();
    });

    it("disposes every listener it registered", async () => {
      // Three config observers, one config change, one command map, and the
      // five window listeners.
      expect(mainModule.disposables.disposables.size).toBe(10);
      await lumine.packages.deactivatePackage("column-selection");
      expect(mainModule.disposables.disposables).toBeNull();
    });
  });

  describe("the autoscroll loop", () => {
    it("stops when picker mode takes the mouse up", () => {
      // Sticky mode makes the left button start a drag, which is what puts the
      // release into the picker's `which === 1` branch -- the one path out of
      // a gesture that never reaches resetGesture.
      mainModule.toggleSticky();
      element.dispatchEvent(eventAt("mousedown", { row: 0, column: 2 }, { button: 0 }));
      element.dispatchEvent(eventAt("mousemove", { row: 1, column: 5 }, { button: 0 }));
      expect(mainModule.dragging).toBe(true);

      mainModule.togglePicker();
      element.dispatchEvent(eventAt("mouseup", { row: 1, column: 5 }, { button: 0 }));

      expect(mainModule.dragging).toBe(false);
    });

    it("really stops scheduling frames", async () => {
      const scrolls = spyOn(component, "autoscrollOnMouseDrag");
      mainModule.toggleSticky();
      element.dispatchEvent(eventAt("mousedown", { row: 0, column: 2 }, { button: 0 }));
      element.dispatchEvent(eventAt("mousemove", { row: 1, column: 5 }, { button: 0 }));

      await waitFrames(2);
      expect(scrolls.calls.count()).toBeGreaterThan(0);

      mainModule.togglePicker();
      element.dispatchEvent(eventAt("mouseup", { row: 1, column: 5 }, { button: 0 }));
      const settled = scrolls.calls.count();

      await waitFrames(3);
      expect(scrolls.calls.count()).toBe(settled);
      // The loop owns the token and drops it on the way out, so this is what
      // says the chain ended rather than merely idling.
      expect(mainModule.autoscrollToken).toBeNull();
    });

    it("starts one loop per gesture, not one per press", () => {
      // Sticky mode accepts the left button and the configured button both, so
      // two presses without a release in between used to arm two loops -- and
      // two loops scroll at twice the speed, which grows the box faster still.
      mainModule.toggleSticky();
      element.dispatchEvent(eventAt("mousedown", { row: 0, column: 2 }, { button: 0 }));
      const token = mainModule.autoscrollToken;
      expect(token).toBeTruthy();

      element.dispatchEvent(eventAt("mousedown", { row: 0, column: 3 }, { button: 2 }));
      expect(mainModule.autoscrollToken).toBe(token);

      element.dispatchEvent(eventAt("mouseup", { row: 0, column: 3 }, { button: 2 }));
      expect(mainModule.autoscrollToken).toBeNull();
    });
  });

  describe("merging", () => {
    it("leaves the box's rows unmerged until the gesture ends", () => {
      useLines(6);
      editor.setCursorScreenPosition([0, 0]);
      mainModule.toggleSticky();

      element.dispatchEvent(
        eventAt("mousedown", { row: 3, column: 5 }, { button: 0, shiftKey: true }),
      );

      // The anchor's own empty selection is preserved alongside the box, and
      // the box's first row starts on top of it. Nothing resolves that while
      // the gesture is running.
      expect(editor.getSelections().length).toBe(5);
      expect(editor.getSelectedBufferRanges()[0]).toEqual([
        [0, 0],
        [0, 0],
      ]);

      element.dispatchEvent(eventAt("mouseup", { row: 3, column: 5 }, { button: 0 }));

      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [0, 0],
          [0, 5],
        ],
        [
          [1, 0],
          [1, 5],
        ],
        [
          [2, 0],
          [2, 5],
        ],
        [
          [3, 0],
          [3, 5],
        ],
      ]);
      expect(editor.getSelections().map((selection) => selection.isReversed())).toEqual([
        false,
        false,
        false,
        false,
      ]);
    });

    it("merges a preserved selection the box grows into", () => {
      useLines(6);
      lumine.config.set("editor.multiCursorOnClick", true);
      editor.setSelectedBufferRange([
        [1, 0],
        [1, 10],
      ]);

      element.dispatchEvent(
        eventAt("mousedown", { row: 0, column: 2 }, { button: 2, ctrlKey: true }),
      );
      element.dispatchEvent(eventAt("mousemove", { row: 3, column: 6 }, { button: 2 }));

      // Four box rows plus the selection the gesture was told to keep.
      expect(editor.getSelections().length).toBe(5);

      element.dispatchEvent(eventAt("mouseup", { row: 3, column: 6 }, { button: 2 }));

      // Selections come back in the order they were created, so the preserved
      // one keeps its slot at the front and the box row it swallowed is simply
      // absent -- row 1's [1, 2]-[1, 6] is inside it.
      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [1, 0],
          [1, 10],
        ],
        [
          [0, 2],
          [0, 6],
        ],
        [
          [2, 2],
          [2, 6],
        ],
        [
          [3, 2],
          [3, 6],
        ],
      ]);
    });
  });

  describe("scrolling", () => {
    it("follows a sticky gesture to the bottom edge", () => {
      useLines(200);
      editor.setCursorScreenPosition([0, 0]);
      mainModule.toggleSticky();
      expect(component.getScrollTop()).toBe(0);

      // Well below the editor; the component clamps the pointer to its own
      // scroll container, so this lands on the bottom-most visible row.
      element.dispatchEvent(
        eventAtPixel(
          "mousedown",
          { top: 10000, left: 5 * charWidth },
          { button: 0, shiftKey: true },
        ),
      );
      component.updateSync();

      expect(component.getScrollTop()).toBeGreaterThan(0);
    });

    it("completes a picker box without moving the viewport", () => {
      useLines(200);
      mainModule.togglePicker();
      const before = component.getScrollTop();

      element.dispatchEvent(eventAt("mouseup", { row: 0, column: 2 }, { button: 0 }));
      element.dispatchEvent(eventAt("mouseup", { row: 3, column: 6 }, { button: 0 }));
      component.updateSync();

      expect(component.getScrollTop()).toBe(before);
      expect(mainModule.pickerFlag).toBe(false);
      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [0, 2],
          [0, 6],
        ],
        [
          [1, 2],
          [1, 6],
        ],
        [
          [2, 2],
          [2, 6],
        ],
        [
          [3, 2],
          [3, 6],
        ],
      ]);
    });
  });

  describe("folds", () => {
    // Row-range folds rather than foldBufferRow: the fixture is plain text with
    // no grammar to say what is foldable.
    function foldTwoRegions() {
      useLines(20);
      editor.foldBufferRowRange(4, 6);
      editor.foldBufferRowRange(12, 14);
      component.updateSync();
      expect(editor.isFoldedAtBufferRow(4)).toBeTruthy();
      expect(editor.isFoldedAtBufferRow(12)).toBeTruthy();
    }

    it("keeps a fold the box is dragged across", () => {
      foldTwoRegions();

      // Screen row 4 is the folded region; the box runs from above it to below.
      element.dispatchEvent(eventAt("mousedown", { row: 2, column: 2 }, { button: 2 }));
      element.dispatchEvent(eventAt("mousemove", { row: 6, column: 6 }, { button: 2 }));
      element.dispatchEvent(eventAt("mouseup", { row: 6, column: 6 }, { button: 2 }));

      expect(editor.isFoldedAtBufferRow(4)).toBeTruthy();
      expect(editor.isFoldedAtBufferRow(12)).toBeTruthy();
    });

    it("a plain selection still drops the fold it crosses", () => {
      // The control for the spec above: it proves this harness can see a fold
      // die, so asserting that one survived is not vacuous.
      foldTwoRegions();

      editor.setSelectedBufferRange([
        [5, 0],
        [5, 2],
      ]);

      expect(editor.isFoldedAtBufferRow(4)).toBeFalsy();
      expect(editor.isFoldedAtBufferRow(12)).toBeTruthy();
    });

    it("never asks the marker index about folds while dragging", () => {
      // The fold pass costs two marker-index queries per write and per frame,
      // and it can only ever find a fold when a selection endpoint is inside
      // one -- which a box's endpoints, being positions the pointer resolved on
      // screen, never are. So this is what preserving folds actually buys, and
      // a call count is the only way to see it.
      useLines(20);
      const folds = spyOn(editor.displayLayer, "destroyFoldsContainingBufferPositions");

      element.dispatchEvent(eventAt("mousedown", { row: 1, column: 2 }, { button: 2 }));
      element.dispatchEvent(eventAt("mousemove", { row: 8, column: 6 }, { button: 2 }));
      element.dispatchEvent(eventAt("mouseup", { row: 8, column: 6 }, { button: 2 }));

      expect(folds.calls.count()).toBe(0);
    });
  });

  describe("reusing the previous frame's box", () => {
    // The autoscroll loop is stubbed inert so nothing scrolls between the
    // scripted moves, which is what makes the translation counts exact. The
    // throttle is leading-edge, so each dispatched move runs synchronously and
    // a frame is yielded before the next one re-arms it.
    beforeEach(() => {
      spyOn(component, "autoscrollOnMouseDrag");
    });

    it("lands exactly where computing every row from scratch lands", async () => {
      useLines(10);
      element.dispatchEvent(eventAt("mousedown", { row: 4, column: 4 }, { button: 2 }));

      // Grow, shrink, a flip across the anchor, a descending grow, and a
      // column change: every move the cache can and cannot absorb.
      const legs = [
        { row: 8, column: 7 },
        { row: 6, column: 7 },
        { row: 1, column: 7 },
        { row: 0, column: 7 },
        { row: 3, column: 2 },
      ];
      for (const leg of legs) {
        element.dispatchEvent(eventAt("mousemove", leg, { button: 2 }));
        // The oracle knows nothing about the cache, which is the point.
        const expected = mainModule.rangesForBox(mainModule.mouseStart, mainModule.mouseEnd);
        expect(editor.getSelectedBufferRanges()).toEqual(expected);
        await waitFrames(1);
      }

      expect(editor.getSelections().every((selection) => selection.isReversed())).toBe(true);
      element.dispatchEvent(eventAt("mouseup", { row: 3, column: 2 }, { button: 2 }));
      // Creation order: a descending box walks from the anchor down, so row 4
      // was written before row 3.
      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [4, 2],
          [4, 4],
        ],
        [
          [3, 2],
          [3, 4],
        ],
      ]);
    });

    it("translates only the rows the pointer newly crossed", async () => {
      useLines(20);
      element.dispatchEvent(eventAt("mousedown", { row: 1, column: 2 }, { button: 2 }));
      element.dispatchEvent(eventAt("mousemove", { row: 4, column: 6 }, { button: 2 }));
      await waitFrames(1);

      const translate = spyOn(editor, "bufferRangeForScreenRange").and.callThrough();
      element.dispatchEvent(eventAt("mousemove", { row: 6, column: 6 }, { button: 2 }));

      expect(translate.calls.count()).toBe(2);
      expect(editor.getSelections().length).toBe(6);
      element.dispatchEvent(eventAt("mouseup", { row: 6, column: 6 }, { button: 2 }));
    });

    it("leaves the selections it already wrote alone", async () => {
      useLines(20);
      element.dispatchEvent(eventAt("mousedown", { row: 1, column: 2 }, { button: 2 }));
      element.dispatchEvent(eventAt("mousemove", { row: 4, column: 6 }, { button: 2 }));
      await waitFrames(1);

      const untouched = spyOn(editor.getSelections()[1], "setBufferRange").and.callThrough();
      element.dispatchEvent(eventAt("mousemove", { row: 6, column: 6 }, { button: 2 }));

      expect(untouched.calls.count()).toBe(0);
      expect(editor.getSelections().length).toBe(6);
      element.dispatchEvent(eventAt("mouseup", { row: 6, column: 6 }, { button: 2 }));
    });

    it("grows past a preserved selection without rewriting it", async () => {
      useLines(10);
      lumine.config.set("editor.multiCursorOnClick", true);
      editor.setSelectedBufferRange([
        [7, 0],
        [7, 3],
      ]);

      element.dispatchEvent(
        eventAt("mousedown", { row: 0, column: 1 }, { button: 2, ctrlKey: true }),
      );
      element.dispatchEvent(eventAt("mousemove", { row: 2, column: 5 }, { button: 2 }));
      await waitFrames(1);

      const preserved = spyOn(editor.getSelections()[0], "setBufferRange").and.callThrough();
      element.dispatchEvent(eventAt("mousemove", { row: 3, column: 5 }, { button: 2 }));
      expect(preserved.calls.count()).toBe(0);

      element.dispatchEvent(eventAt("mouseup", { row: 3, column: 5 }, { button: 2 }));
      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [7, 0],
          [7, 3],
        ],
        [
          [0, 1],
          [0, 5],
        ],
        [
          [1, 1],
          [1, 5],
        ],
        [
          [2, 1],
          [2, 5],
        ],
        [
          [3, 1],
          [3, 5],
        ],
      ]);
    });

    it("flips between bare cursors and real ranges at a content boundary", async () => {
      editor.setText("\n\n\n0123456789\n0123456789\n");
      component.updateSync();

      // The empty rows have nothing rendered to measure against, so the
      // pointer position must come from raw pixels: past the end of the line
      // the package counts character widths itself.
      element.dispatchEvent(
        eventAtPixel("mousedown", { top: lineHeight / 2, left: 0.2 * charWidth }, { button: 2 }),
      );
      const overEmptyRows = { top: 2.5 * lineHeight, left: 6.2 * charWidth };
      element.dispatchEvent(eventAtPixel("mousemove", overEmptyRows, { button: 2 }));

      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [0, 0],
          [0, 0],
        ],
        [
          [1, 0],
          [1, 0],
        ],
        [
          [2, 0],
          [2, 0],
        ],
      ]);

      // One row further sits real text: the bucket flips and the bare cursors
      // retroactively drop out, which only the full walk decides correctly.
      await waitFrames(1);
      element.dispatchEvent(
        eventAt("mousemove", { row: 3, column: 6, offset: 0.2 }, { button: 2 }),
      );
      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [3, 0],
          [3, 6],
        ],
      ]);

      // And back: trimming the only kept row empties the cache, and the rows
      // the walk discarded on the way out become the box again.
      await waitFrames(1);
      element.dispatchEvent(eventAtPixel("mousemove", overEmptyRows, { button: 2 }));
      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [0, 0],
          [0, 0],
        ],
        [
          [1, 0],
          [1, 0],
        ],
        [
          [2, 0],
          [2, 0],
        ],
      ]);
      element.dispatchEvent(eventAtPixel("mouseup", overEmptyRows, { button: 2 }));
    });

    it("recomputes every row after the buffer changes under the drag", async () => {
      useLines(8);
      element.dispatchEvent(eventAt("mousedown", { row: 0, column: 2 }, { button: 2 }));
      element.dispatchEvent(eventAt("mousemove", { row: 3, column: 6 }, { button: 2 }));
      await waitFrames(1);

      // The edit drifts row 1's selection marker right by two columns, so the
      // final assertion is meaningful only if the next frame rewrites it.
      editor.setTextInBufferRange(
        [
          [1, 0],
          [1, 0],
        ],
        "XX",
      );
      component.updateSync();
      expect(mainModule.boxCache).toBeNull();

      element.dispatchEvent(eventAt("mousemove", { row: 4, column: 6 }, { button: 2 }));
      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [0, 2],
          [0, 6],
        ],
        [
          [1, 2],
          [1, 6],
        ],
        [
          [2, 2],
          [2, 6],
        ],
        [
          [3, 2],
          [3, 6],
        ],
        [
          [4, 2],
          [4, 6],
        ],
      ]);
      element.dispatchEvent(eventAt("mouseup", { row: 4, column: 6 }, { button: 2 }));
    });

    it("rebuilds the box after something else consolidates its selections", async () => {
      useLines(8);
      element.dispatchEvent(eventAt("mousedown", { row: 0, column: 2 }, { button: 2 }));
      element.dispatchEvent(eventAt("mousemove", { row: 3, column: 6 }, { button: 2 }));
      expect(editor.getSelections().length).toBe(4);
      await waitFrames(1);

      // The escape keystroke's path: everything but the last selection dies.
      editor.consolidateSelections();
      expect(mainModule.boxCache).toBeNull();

      element.dispatchEvent(eventAt("mousemove", { row: 4, column: 6 }, { button: 2 }));
      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [0, 2],
          [0, 6],
        ],
        [
          [1, 2],
          [1, 6],
        ],
        [
          [2, 2],
          [2, 6],
        ],
        [
          [3, 2],
          [3, 6],
        ],
        [
          [4, 2],
          [4, 6],
        ],
      ]);
      element.dispatchEvent(eventAt("mouseup", { row: 4, column: 6 }, { button: 2 }));
    });

    it("keeps a leftward box reversed while it grows", async () => {
      useLines(8);
      element.dispatchEvent(eventAt("mousedown", { row: 0, column: 6 }, { button: 2 }));
      element.dispatchEvent(eventAt("mousemove", { row: 3, column: 2 }, { button: 2 }));
      await waitFrames(1);
      element.dispatchEvent(eventAt("mousemove", { row: 5, column: 2 }, { button: 2 }));

      expect(editor.getSelections().length).toBe(6);
      expect(editor.getSelections().every((selection) => selection.isReversed())).toBe(true);
      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [0, 2],
          [0, 6],
        ],
        [
          [1, 2],
          [1, 6],
        ],
        [
          [2, 2],
          [2, 6],
        ],
        [
          [3, 2],
          [3, 6],
        ],
        [
          [4, 2],
          [4, 6],
        ],
        [
          [5, 2],
          [5, 6],
        ],
      ]);
      element.dispatchEvent(eventAt("mouseup", { row: 5, column: 2 }, { button: 2 }));
    });

    it("selects nothing while the box is past every line's end", async () => {
      editor.setText("01\n01\n01\n01\n");
      component.updateSync();
      editor.setSelectedBufferRange([
        [0, 0],
        [0, 0],
      ]);

      // Both corners resolve past the short lines, so every row clips to the
      // line end without touching either box column: no row qualifies, the
      // frame keeps the previous selections, and nothing is cached for a
      // later frame to measure a delta against.
      const right = 5.2 * charWidth;
      element.dispatchEvent(
        eventAtPixel("mousedown", { top: lineHeight / 2, left: right }, { button: 2 }),
      );
      for (const rows of [1.5, 2.5]) {
        element.dispatchEvent(
          eventAtPixel("mousemove", { top: rows * lineHeight, left: right }, { button: 2 }),
        );
        expect(editor.getSelectedBufferRanges()).toEqual([
          [
            [0, 0],
            [0, 0],
          ],
        ]);
        expect(mainModule.boxCache).toBeNull();
        await waitFrames(1);
      }
      element.dispatchEvent(
        eventAtPixel("mouseup", { top: 2.5 * lineHeight, left: right }, { button: 2 }),
      );
    });
  });

  describe("when the editor is destroyed mid-gesture", () => {
    // Built before the editor dies: the helpers measure through the component,
    // which is gone afterwards.
    function startGestureAndDestroy() {
      const release = eventAt("mouseup", { row: 1, column: 5 }, { button: 2 });
      element.dispatchEvent(eventAt("mousedown", { row: 0, column: 2 }, { button: 2 }));
      element.dispatchEvent(eventAt("mousemove", { row: 1, column: 5 }, { button: 2 }));
      expect(mainModule.editor).toBe(editor);
      editor.destroy();
      return release;
    }

    it("lets go of the editor", () => {
      startGestureAndDestroy();
      expect(mainModule.editor).toBeNull();
      expect(mainModule.boxCache).toBeNull();
      expect(mainModule.editorDisposable).toBeNull();
      expect(mainModule.dragging).toBe(false);
      expect(mainModule.autoscrollToken).toBeNull();
    });

    it("leaves the editor's own teardown to finish", () => {
      startGestureAndDestroy();
      // `component` is nulled on the line after `did-destroy` is emitted, so a
      // handler that threw would leave it set.
      expect(editor.component).toBeNull();
    });

    it("survives the mouse up that follows", () => {
      const release = startGestureAndDestroy();
      // Called rather than dispatched: dispatchEvent swallows a listener's
      // exception into a global error report, so a throw would not be visible.
      expect(() => mainModule.mouseUp(release)).not.toThrow();
      expect(mainModule.editor).toBeNull();
    });
  });

  describe("resolving the column under the pointer", () => {
    it("names the column the pointer is over", () => {
      mainModule.editor = editor;
      const position = mainModule.screenPositionForMouseEvent(
        eventAt("mousemove", {
          row: 0,
          column: 3,
        }),
      );
      expect(position).toEqual({ row: 0, column: 3 });
    });

    it("counts whole characters past the end of the line", () => {
      mainModule.editor = editor;
      // The renderer clamps to the end of the line, so this is the one place
      // the package still counts in character widths — there is nothing drawn
      // out here to measure against.
      const position = mainModule.screenPositionForMouseEvent(
        eventAt("mousemove", {
          row: 0,
          column: 10,
          offset: 4.25,
        }),
      );
      expect(position).toEqual({ row: 0, column: 14 });
    });

    it("looks past width that belongs to no column", () => {
      decorateWithHint([
        [0, 5],
        [0, 6],
      ]);

      // Every column from the fifth on is drawn a label's width to the right
      // of where a character count would put it.
      expect(leftOf(0, 7)).toBeGreaterThan(8 * charWidth);

      mainModule.editor = editor;
      const position = mainModule.screenPositionForMouseEvent(
        eventAt("mousemove", {
          row: 0,
          column: 7,
        }),
      );
      expect(position).toEqual({ row: 0, column: 7 });
    });

    it("resolves a pointer on the label itself to the column it decorates", () => {
      decorateWithHint([
        [0, 5],
        [0, 6],
      ]);

      // The label fills the gap between the end of the fourth character and
      // the start of the fifth. No text is drawn there at all.
      const labelStart = leftOf(0, 4) + charWidth;
      const labelEnd = leftOf(0, 5);
      expect(labelEnd - labelStart).toBeGreaterThan(charWidth);

      mainModule.editor = editor;
      const position = mainModule.screenPositionForMouseEvent(
        eventAtPixel("mousemove", { top: lineHeight / 2, left: (labelStart + labelEnd) / 2 }),
      );
      expect(position).toEqual({ row: 0, column: 5 });
    });

    it("drags a rectangle in columns rather than in pixels", () => {
      decorateWithHint([
        [0, 2],
        [0, 3],
      ]);

      element.dispatchEvent(eventAt("mousedown", { row: 0, column: 5 }, { button: 2 }));
      element.dispatchEvent(eventAt("mousemove", { row: 1, column: 8 }, { button: 2 }));
      element.dispatchEvent(eventAt("mouseup", { row: 1, column: 8 }, { button: 2 }));

      // The hinted row and the plain row select the same columns: the label
      // moved where those columns are drawn, not which characters they are.
      expect(editor.getSelectedBufferRanges()).toEqual([
        [
          [0, 5],
          [0, 8],
        ],
        [
          [1, 5],
          [1, 8],
        ],
      ]);
    });
  });
});
