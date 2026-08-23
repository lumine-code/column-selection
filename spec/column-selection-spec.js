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
