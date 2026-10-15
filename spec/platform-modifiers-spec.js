const path = require("path");

describe("column-selection platform mouse modifiers", () => {
  let main, editor, element, component, descriptor;

  beforeEach(async () => {
    const workspace = lumine.workspace.getElement();
    workspace.style.height = "300px";
    workspace.style.width = "1000px";
    jasmine.attachToDOM(workspace);
    main = (await lumine.packages.activatePackage(path.join(__dirname, ".."))).mainModule;
    editor = await lumine.workspace.open();
    editor.setText("0123456789\nabcdefghij\nklmnopqrst\n");
    element = editor.getElement();
    component = element.getComponent();
    component.updateSync();
    editor.setSelectedBufferRange([
      [2, 0],
      [2, 3],
    ]);
    component.updateSync();
    lumine.config.set("editor.multiCursorOnClick", true);
    descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", descriptor);
    await lumine.packages.deactivatePackage("column-selection");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });

  function platform(name) {
    Object.defineProperty(process, "platform", { configurable: true, value: name });
  }

  // Call the package's capture-phase handlers directly so the editor's own
  // mouse handler keeps its real platform while this spec simulates all three.
  function send(type, row, column, properties = {}) {
    const pixel = component.pixelPositionForScreenPosition({ row, column });
    const rect = element.querySelector(".lines").getBoundingClientRect();
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + pixel.left + editor.getDefaultCharWidth() / 2,
      clientY: rect.top + pixel.top + editor.getLineHeightInPixels() / 2,
      ...properties,
    });
    Object.defineProperty(event, "target", { value: element });
    main[
      {
        mousedown: "mouseDown",
        mouseup: "mouseUp",
        mousemove: "mouseMove",
        contextmenu: "contextMenu",
      }[type]
    ](event);
    return event;
  }

  const existing = [
    [2, 0],
    [2, 3],
  ];
  const box = [
    [
      [0, 2],
      [0, 5],
    ],
    [
      [1, 2],
      [1, 5],
    ],
  ];

  for (const name of ["win32", "linux", "darwin"]) {
    for (const modifier of ["ctrlKey", "metaKey"]) {
      const preserves = modifier === (name === "darwin" ? "metaKey" : "ctrlKey");
      it(`${preserves ? "preserves" : "replaces"} existing selections for ${modifier} drag on ${name}`, () => {
        platform(name);
        send("mousedown", 0, 2, { button: 2, [modifier]: true });
        send("mousemove", 1, 5, { button: 2 });
        send("mouseup", 1, 5, { button: 2 });
        expect(editor.getSelectedBufferRanges()).toEqual(preserves ? [existing, ...box] : box);
      });
    }

    it(`adds a picker rectangle using the platform primary modifier on ${name}`, () => {
      platform(name);
      main.togglePicker();
      send("mousedown", 0, 2);
      send("mouseup", 0, 2);
      const modifier = name === "darwin" ? "metaKey" : "ctrlKey";
      send("mousedown", 1, 5, { [modifier]: true });
      send("mouseup", 1, 5, { [modifier]: true });
      expect(editor.getSelectedBufferRanges()).toEqual([existing, ...box]);
      expect(main.pickerFlag).toBeFalse();
    });
  }

  for (const mode of ["configured", "sticky", "picker"]) {
    it(`leaves macOS Control-click contextual in ${mode} mode`, () => {
      platform("darwin");
      if (mode === "configured") main.mouseButton = 1;
      else if (mode === "sticky") main.toggleSticky();
      else main.togglePicker();
      // A previous column gesture must not suppress this native context menu.
      main.context = true;
      const down = send("mousedown", 0, 2, { ctrlKey: true });
      const up = send("mouseup", 0, 2, { ctrlKey: true });
      const context = send("contextmenu", 0, 2, { ctrlKey: true });
      expect(down.defaultPrevented || up.defaultPrevented || context.defaultPrevented).toBeFalse();
      expect(editor.getSelectedBufferRanges()).toEqual([existing]);
      expect(main.editor).toBeNull();
      expect(main.dragging).toBeFalse();
      if (mode === "picker") expect(main.pickerFlag).toBeTrue();
    });
  }

  it("keeps a pending picker corner while macOS Control-click opens a context menu", () => {
    platform("darwin");
    main.togglePicker();
    send("mousedown", 0, 2);
    send("mouseup", 0, 2);
    const start = { ...main.mouseStart };
    send("mousedown", 1, 5, { ctrlKey: true });
    send("mouseup", 1, 5, { ctrlKey: true });
    expect(main.pickerFlag).toBe(1);
    expect(main.mouseStart).toEqual(start);
    expect(editor.getSelectedBufferRanges()).toEqual([existing]);
    send("mousedown", 1, 5, { metaKey: true });
    send("mouseup", 1, 5, { metaKey: true });
    expect(editor.getSelectedBufferRanges()).toEqual([existing, ...box]);
  });
});
