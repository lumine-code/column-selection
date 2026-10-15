describe("column-selection status actions", () => {
  const { createRequire } = require("node:module");
  const coreRequire = createRequire(
    require("node:path").join(lumine.application.getResourcePath(), "package.json"),
  );
  const { humanizeKeystroke } = coreRequire("@lumine-code/underscore-plus");
  const primary = process.platform === "darwin" ? "cmd" : "ctrl";
  const stickyStroke = `${primary}-k q`;
  const pickerStroke = `${primary}-k shift-q`;
  let main, resources, window;
  const commands = () => lumine.contextMenu.templateForElement(resources.widget);
  const shortcuts = () => [humanizeKeystroke(stickyStroke), humanizeKeystroke(pickerStroke)];
  const popupLabels = (target) => {
    const popup = lumine.contextMenu.show(target, lumine.contextMenu.templateForElement(target));
    try {
      return Array.from(
        popup.element.querySelectorAll(".menu-item-keystroke"),
        (element) => element.textContent,
      );
    } finally {
      popup.close({ cancelled: true, restoreFocus: false });
    }
  };
  beforeEach(async () => {
    jasmine.useRealClock();
    window = lumine.workspace.getMainWindow();
    jasmine.attachToDOM(window.getElement());
    window.getElement().focus();
    await lumine.packages.activatePackage("status-bar");
    main = (await lumine.packages.activatePackage("column-selection")).mainModule;
    await flushMicrotasks();
    resources = Array.from(main.statusBarConnections.values()).find(
      (connection) => connection.context.window === window,
    );
    expect(resources.widget.closest("status-bar")).not.toBeNull();
    expect(resources.widget.isConnected).toBeTrue();
  });
  afterEach(async () => {
    main.destroyStatusBarConnection(resources);
    await lumine.packages.deactivatePackage("column-selection");
    await lumine.packages.deactivatePackage("status-bar");
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

  it("shows the primary global shortcut before an editor is opened", async () => {
    const [tooltip] = lumine.tooltips.findTooltips(resources.widget);
    expect(tooltip.options.keyBindingTarget).toBe(window.getElement());
    expect(tooltip.getTitle()).toContain(humanizeKeystroke(stickyStroke));
    await lumine.workspace.open();
    expect(tooltip.options.keyBindingTarget).toBe(window.getElement());
    expect(tooltip.getTitle()).toContain("keystroke");
    expect(tooltip.getTitle()).not.toContain("MMB");
  });

  it("renders both global shortcuts in the real status popup with or without an editor", async () => {
    expect(commands().map((item) => item.keyBindingLabel)).toEqual(shortcuts());
    expect(popupLabels(resources.widget)).toEqual(shortcuts());
    const editor = await lumine.workspace.open();
    expect(commands().map((item) => item.keyBindingLabel)).toEqual(shortcuts());
    expect(
      lumine.contextMenu
        .templateForElement(resources.widget.querySelector(".icon"))
        .map((item) => item.keyBindingLabel),
    ).toEqual(shortcuts());
    expect(popupLabels(resources.widget.querySelector(".icon"))).toEqual(shortcuts());
    await lumine.workspace.getActivePane().destroyItem(editor, true);
    window.getElement().focus();
    expect(commands().map((item) => item.keyBindingLabel)).toEqual(shortcuts());
    expect(popupLabels(resources.widget)).toEqual(shortcuts());
  });

  it("arms both global modes from the real status popup before opening an editor", async () => {
    expect(lumine.workspace.getTextEditors()).toEqual([]);
    for (const index of [0, 1]) {
      const popup = lumine.contextMenu.show(resources.widget, commands());
      popup.element.querySelectorAll('[role="menuitemcheckbox"]')[index].click();
      expect(popup.closed).toBeTrue();
      await flushMicrotasks();
    }
    expect(main.stickyFlag).toBeTrue();
    expect(main.pickerFlag).toBeTrue();
  });

  it("dispatches each global shortcut from an empty workspace, a sidebar and a mini editor", () => {
    const sidebar = document.createElement("button");
    lumine.workspace.getLeftDock().getElement().appendChild(sidebar);
    const mini = lumine.workspace.buildTextEditor({ mini: true });
    window.getElement().appendChild(mini.getElement());
    const sticky = spyOn(main, "toggleSticky").and.callThrough();
    const picker = spyOn(main, "togglePicker").and.callThrough();
    try {
      for (const target of [window.getElement(), sidebar, mini.getElement()]) {
        for (const [stroke, command] of [
          [stickyStroke, "column-selection:sticky"],
          [pickerStroke, "column-selection:picker"],
        ]) {
          const binding = lumine.keymaps.findKeyBindings({ keystrokes: stroke, target })[0];
          expect(binding.selector).toBe("lumine-workspace");
          expect(binding.command).toBe(command);
          if (binding.command === command) lumine.commands.dispatch(target, binding.command);
        }
      }
      expect(sticky).toHaveBeenCalledTimes(3);
      expect(picker).toHaveBeenCalledTimes(3);
      expect(main.stickyFlag).toBeTrue();
      expect(main.pickerFlag).toBeTrue();
    } finally {
      mini.destroy();
      mini.getElement().remove();
      sidebar.remove();
    }
  });

  it("keeps the literal global shortcuts available outside editors", () => {
    const lookup = (keystrokes) =>
      lumine.keymaps.findKeyBindings({ keystrokes, target: window.getElement() })[0];
    expect(lookup(stickyStroke).command).toBe("column-selection:sticky");
    expect(lookup(pickerStroke).command).toBe("column-selection:picker");
    expect(lookup(`${primary}-q`).command).toBe("application:quit");
  });

  it("renders both application-menu aliases when invoked from a dock instead of an editor", () => {
    const pack = lumine.packages.getLoadedPackage("column-selection");
    const menu = pack.menus.find(([, definition]) => definition.menu)[1].menu;
    const dock = lumine.workspace.getLeftDock();
    const button = document.createElement("button");
    button.textContent = "Column Selection spec dock target";
    dock.getElement().appendChild(button);
    dock.show();
    button.focus();
    expect(document.activeElement).toBe(button);
    try {
      for (const contribution of menu) {
        const popup = lumine.menu.showPopup({
          target: button,
          anchor: button,
          template: contribution.submenu[0].submenu,
        });
        try {
          expect(
            Array.from(
              popup.element.querySelectorAll(".menu-item-keystroke"),
              (element) => element.textContent,
            ),
          ).toEqual(shortcuts());
        } finally {
          popup.close({ cancelled: true, restoreFocus: false });
        }
      }
    } finally {
      button.remove();
      dock.hide();
    }
  });

  it("uses each owning window's user keymap even when neither window has an editor", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    await flushMicrotasks();
    const remote = Array.from(main.statusBarConnections.values()).find(
      (connection) => connection.context.window === extra,
    );
    expect(remote.widget.closest("status-bar")).not.toBeNull();
    extra.getElement().classList.add("column-selection-spec-user-window");
    const userMap = lumine.keymaps.add(
      "column-selection-spec-user-window",
      {
        ".column-selection-spec-user-window": {
          "ctrl-alt-q": "column-selection:sticky",
          "ctrl-alt-p": "column-selection:picker",
        },
      },
      100,
    );
    const labels = () =>
      lumine.contextMenu.templateForElement(remote.widget).map((item) => item.keyBindingLabel);
    try {
      extra.getElement().focus();
      const expected = [humanizeKeystroke("ctrl-alt-q"), humanizeKeystroke("ctrl-alt-p")];
      expect(labels()).toEqual(expected);
      expect(popupLabels(remote.widget)).toEqual(expected);
      expect(commands().map((item) => item.keyBindingLabel)).toEqual(shortcuts());
      const [tooltip] = lumine.tooltips.findTooltips(remote.widget);
      expect(tooltip.getTitle()).toContain(expected[0]);
      const editor = lumine.workspace.buildTextEditor();
      extra.getEditorContainer().getActivePane().activateItem(editor);
      editor.getElement().focus();
      expect(labels()).toEqual(expected);
      lumine.commands.dispatch(remote.widget, "column-selection:picker");
      expect(main.pickerFlag).toBeTrue();
    } finally {
      userMap.dispose();
      extra.getElement().classList.remove("column-selection-spec-user-window");
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
