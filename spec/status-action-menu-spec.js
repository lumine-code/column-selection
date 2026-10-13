describe("column-selection status actions", () => {
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
    expect(commands().map((item) => item.mouseBindingLabel)).toEqual(["LMB", "MMB"]);
    const [tooltip] = lumine.tooltips.findTooltips(element);
    expect(tooltip.options.keyBindingCommand).toBeUndefined();
    expect(tooltip.getTitle()).toContain("Click to toggle sticky mode.");
    element.dispatchEvent(new MouseEvent("mouseup", { button: 2 }));
    expect(main.stickyFlag).toBe(false);
    expect(main.pickerFlag).toBe(false);
    element.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { button: 1 }));
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
