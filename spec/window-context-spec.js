describe("column-selection window status", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("status-bar");
    await lumine.packages.activatePackage("column-selection");
  });
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
  });
  it("creates controls in future windows and removes only that package's controls on unload", async () => {
    const main = lumine.workspace.getMainWindow();
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    expect(main.getElement().querySelector(".column-selection-icon")).not.toBeNull();
    const element = extra.getElement().querySelector(".column-selection-icon");
    expect(element).not.toBeNull();
    expect(element.ownerDocument).toBe(extra.getDocument());
    await lumine.packages.deactivatePackage("column-selection");
    for (const window of lumine.workspace.getWindows())
      expect(window.getElement().querySelector(".column-selection-icon")).toBeNull();
    expect(extra.getElement().querySelector("status-bar")).not.toBeNull();
  });
  it("listens to pointer gestures in additional documents", async () => {
    const main = lumine.packages.getActivePackage("column-selection").mainModule;
    const down = spyOn(main, "mouseDown").and.callThrough();
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const event = new (extra.getDOMWindow().MouseEvent)("mousedown", { bubbles: true });
    extra.getDocument().body.dispatchEvent(event);
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("ends an outstanding drag before its presentation window changes", async () => {
    const main = lumine.packages.getActivePackage("column-selection").mainModule;
    const editor = await lumine.workspace.open();
    const extra = await lumine.workspace.detachItem(editor);
    const frames = [];
    spyOn(extra.getDOMWindow(), "requestAnimationFrame").and.callFake((callback) =>
      frames.push(callback),
    );
    const cancel = spyOn(extra.getDOMWindow(), "cancelAnimationFrame");
    const drag = spyOn(main, "processDragFrame");
    main.setEditor(editor);
    main.dragging = true;
    main.startDragLoop();
    await lumine.workspace.attachWindow(extra);
    expect(cancel).toHaveBeenCalledWith(1);
    expect(main.editor).toBeNull();
    expect(main.dragFrameToken).toBeNull();
    expect(main.dragging).toBeFalse();
    frames[0]();
    expect(drag).not.toHaveBeenCalled();
  });
});
