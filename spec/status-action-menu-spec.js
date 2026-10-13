describe("column-selection status actions", () => {
  const { createRequire } = require("node:module");
  const coreRequire = createRequire(
    require("node:path").join(lumine.application.getResourcePath(), "package.json"),
  );
  const { humanizeKeystroke } = coreRequire("@lumine-code/underscore-plus");
  let main, resources, window;
  const commands = () => lumine.contextMenu.templateForElement(resources.widget);
  beforeEach(async () => {
    window = lumine.workspace.getMainWindow();
    jasmine.attachToDOM(window.getElement());
    main = (await lumine.packages.activatePackage("column-selection")).mainModule;
    resources = main.createStatusBarResources({ addRightTile: () => ({ destroy() {} }) }, window);
    window.getElement().appendChild(resources.widget);
  });
  afterEach(async () => {
    main.destroyStatusBarConnection(resources);
    await lumine.packages.deactivatePackage("column-selection");
  });
  it("offers independent checked actions and leaves right-click free", () => {
    const element = resources.widget;
    expect(commands().map((item) => item.command)).toEqual([
      "column-selection:sticky",
      "column-selection:picker",
    ]);
    const dispatch = spyOn(lumine.commands, "dispatch").and.callThrough();
    const [tooltip] = lumine.tooltips.findTooltips(element);
    expect(tooltip.options.keyBindingCommand).toBe("column-selection:sticky");
    expect(tooltip.options.keyBindingExtra).toBeUndefined();
    expect(tooltip.getTitle()).toContain("Click to toggle sticky mode.");
    expect(tooltip.getTitle()).not.toContain("LMB");
    expect(tooltip.getTitle()).not.toContain("MMB");
    element.dispatchEvent(new MouseEvent("mouseup", { button: 2 }));
    expect(main.stickyFlag).toBe(false);
    expect(main.pickerFlag).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    element.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { button: 1 }));
    expect(dispatch.calls.allArgs().map(([, command]) => command)).toEqual(
      commands().map((item) => item.command),
    );
    expect(commands().map((item) => item.checked)).toEqual([true, true]);
    expect(tooltip.getTitle()).toContain("Sticky on, picker on.");
    lumine.commands.dispatch(element, "column-selection:picker");
    expect(commands().map((item) => item.checked)).toEqual([true, false]);
  });
  it("removes the menu when its tile resources are retired", () => {
    const element = resources.widget;
    main.destroyStatusBarConnection(resources);
    expect(lumine.contextMenu.templateForElement(element)).toEqual([]);
    element.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    expect(main.stickyFlag).toBe(false);
  });

  it("resolves the primary keyboard shortcut from the current editor", async () => {
    const [tooltip] = lumine.tooltips.findTooltips(resources.widget);
    expect(tooltip.options.keyBindingTarget()).toBeNull();
    const editor = await lumine.workspace.open();
    expect(tooltip.options.keyBindingTarget()).toBe(editor.getElement());
    expect(tooltip.getTitle()).toContain("keystroke");
    expect(tooltip.getTitle()).not.toContain("MMB");
  });

  it("shows both editor shortcuts in the menu only while an editor is available", async () => {
    expect(commands().map((item) => item.keyBindingLabel)).toEqual(["", ""]);
    const editor = await lumine.workspace.open();
    expect(commands().map((item) => item.keyBindingLabel)).toEqual([
      humanizeKeystroke("alt-q"),
      humanizeKeystroke("ctrl-q"),
    ]);
    expect(
      lumine.contextMenu
        .templateForElement(resources.widget.querySelector(".icon"))
        .map((item) => item.keyBindingLabel),
    ).toEqual([humanizeKeystroke("alt-q"), humanizeKeystroke("ctrl-q")]);
    await lumine.workspace.getActivePane().destroyItem(editor, true);
    expect(commands().map((item) => item.keyBindingLabel)).toEqual(["", ""]);
  });

  it("uses the invoking window's editor rather than the other window's editor", async () => {
    jasmine.useRealClock();
    await lumine.workspace.open();
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const remote = main.createStatusBarResources({ addRightTile: () => ({ destroy() {} }) }, extra);
    extra.getElement().appendChild(remote.widget);
    const labels = () =>
      lumine.contextMenu.templateForElement(remote.widget).map((item) => item.keyBindingLabel);
    try {
      expect(labels()).toEqual(["", ""]);
      const editor = lumine.workspace.buildTextEditor();
      extra.getEditorContainer().getActivePane().activateItem(editor);
      expect(labels()).toEqual([humanizeKeystroke("alt-q"), humanizeKeystroke("ctrl-q")]);
      lumine.commands.dispatch(remote.widget, "column-selection:picker");
      expect(main.pickerFlag).toBeTrue();
    } finally {
      main.destroyStatusBarConnection(remote);
      await lumine.workspace.discardEditorWindows();
    }
  });

  it("keeps status controls reachable while a picker corner is pending", async () => {
    const editor = await lumine.workspace.open();
    main.setEditor(editor);
    main.pickerFlag = 1;
    main.context = true;
    const showMenu = spyOn(lumine.contextMenu, "showForEvent");
    const element = resources.widget;
    element.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { button: 2, bubbles: true }));
    const event = new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    expect(showMenu).toHaveBeenCalledWith(event);
    expect(main.pickerFlag).toBe(1);
    expect(commands()[1].checked).toBe(true);
    const middle = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true });
    element.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    element.dispatchEvent(new MouseEvent("mouseup", { button: 1, bubbles: true }));
    expect(main.pickerFlag).toBe(false);
  });
});
