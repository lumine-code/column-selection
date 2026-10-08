describe("column-selection status-bar connection lifetime", () => {
  let main, hub, consumer, StatusBarView, bars, providers;
  const widget = (bar) =>
    bar
      .getRightTiles()
      .find((tile) => tile.getItem().classList?.contains("column-selection-icon"))
      ?.getItem();
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("status-bar");
    ({ mainModule: main } = await lumine.packages.activatePackage("column-selection"));
    main.deactivateStatusBar();
    StatusBarView = lumine.packages.getActivePackage("status-bar").mainModule.statusBar.constructor;
    hub = new lumine.packages.serviceHub.constructor();
    consumer = hub.consume("status-bar", "^1.0.0", (bar) => main.consumeStatusBar(bar));
    bars = [];
    providers = [];
  });
  afterEach(async () => {
    consumer.dispose();
    providers.forEach((provider) => provider.dispose());
    await lumine.packages.deactivatePackage("column-selection");
    for (const bar of bars) {
      for (const tile of bar.getRightTiles().slice()) tile.destroy();
      bar.destroy();
    }
  });
  function provide(bar) {
    if (!bar) {
      bar = new StatusBarView();
      bars.push(bar);
      jasmine.attachToDOM(bar.element);
    }
    const provider = hub.provide("status-bar", "1.0.0", bar);
    providers.push(provider);
    return { bar, provider, element: widget(bar) };
  }
  it("owns distinct provider widgets and releases the old edge only", () => {
    const first = provide(),
      second = provide();
    expect(first.bar.getRightTiles().length).toBe(1);
    expect(second.bar.getRightTiles().length).toBe(1);
    first.provider.dispose();
    expect(first.bar.getRightTiles().length).toBe(0);
    expect(second.bar.getRightTiles().length).toBe(1);
    expect(lumine.tooltips.findTooltips(first.element)).toEqual([]);
    if (second.element) expect(lumine.tooltips.findTooltips(second.element).length).toBe(1);
  });
  it("shares one widget until the last identical-payload lease ends", () => {
    const first = provide(),
      second = provide(first.bar);
    expect(first.bar.getRightTiles().length).toBe(1);
    expect(second.element).toBe(first.element);
    first.provider.dispose();
    expect(first.bar.getRightTiles().length).toBe(1);
    second.provider.dispose();
    expect(first.bar.getRightTiles().length).toBe(0);
    expect(lumine.tooltips.findTooltips(first.element)).toEqual([]);
  });
  it("keeps global mode state visible in every owned widget", async () => {
    const first = provide(),
      second = provide();
    main.toggleSticky();
    main.togglePicker();
    for (const bar of [first.bar, second.bar]) {
      expect(widget(bar).querySelector(".icon").classList.contains("sticky")).toBe(true);
      expect(widget(bar).querySelector(".icon").classList.contains("picker")).toBe(true);
    }
    lumine.config.set("column-selection.statusBar", false);
    expect(first.bar.getRightTiles().length).toBe(0);
    expect(second.bar.getRightTiles().length).toBe(0);
    lumine.config.set("column-selection.statusBar", true);
    for (const bar of [first.bar, second.bar]) {
      expect(widget(bar).querySelector(".icon").classList.contains("sticky")).toBe(true);
      expect(widget(bar).querySelector(".icon").classList.contains("picker")).toBe(true);
    }
  });
  it("retires every widget and tooltip on deactivation", async () => {
    const first = provide(),
      second = provide();
    await lumine.packages.deactivatePackage("column-selection");
    for (const entry of [first, second]) {
      expect(entry.bar.getRightTiles().length).toBe(0);
      if (entry.element) expect(lumine.tooltips.findTooltips(entry.element)).toEqual([]);
    }
  });
  it("protects a new activation from an old identical-payload lease", async () => {
    const old = provide();
    await lumine.packages.deactivatePackage("column-selection");
    ({ mainModule: main } = await lumine.packages.activatePackage("column-selection"));
    main.deactivateStatusBar();
    const current = provide(old.bar);
    old.provider.dispose();
    expect(old.bar.getRightTiles().length).toBe(1);
    expect(widget(old.bar)).toBe(current.element);
    current.provider.dispose();
    expect(old.bar.getRightTiles().length).toBe(0);
  });
  it("reflects global mode changes made while its widget is being added", () => {
    const bar = new StatusBarView();
    bars.push(bar);
    const add = bar.addRightTile.bind(bar);
    spyOn(bar, "addRightTile").and.callFake((options) => {
      const tile = add(options);
      main.toggleSticky();
      return tile;
    });
    const lease = main.consumeStatusBar(bar);
    expect(widget(bar).querySelector(".icon").classList.contains("sticky")).toBe(true);
    lease.dispose();
  });

  it("retires resources if deactivation occurs inside tile creation", () => {
    const bar = new StatusBarView();
    bars.push(bar);
    const add = bar.addRightTile.bind(bar);
    let item;
    spyOn(bar, "addRightTile").and.callFake((options) => {
      item = options.item;
      const tile = add(options);
      main.deactivate();
      return tile;
    });
    const lease = main.consumeStatusBar(bar);
    expect(bar.getRightTiles().length).toBe(0);
    expect(lumine.tooltips.findTooltips(item)).toEqual([]);
    lease.dispose();
  });
  it("cleans a failed widget allocation and allows another lease", () => {
    const bar = new StatusBarView();
    bars.push(bar);
    let item;
    const add = spyOn(bar, "addRightTile").and.callFake((options) => {
      item = options.item;
      throw new Error("Tile creation failed");
    });
    expect(() => main.consumeStatusBar(bar)).toThrowError("Tile creation failed");
    expect(lumine.tooltips.findTooltips(item)).toEqual([]);
    add.and.callThrough();
    const lease = main.consumeStatusBar(bar);
    expect(bar.getRightTiles().length).toBe(1);
    lease.dispose();
    expect(bar.getRightTiles().length).toBe(0);
  });

  it("leaves borrowed bars and unrelated tiles alive", () => {
    const entry = provide();
    const destroy = spyOn(entry.bar, "destroy").and.callThrough();
    const tile = entry.bar.addRightTile({ item: document.createElement("span"), priority: 999 });
    entry.provider.dispose();
    expect(destroy).not.toHaveBeenCalled();
    expect(entry.bar.getRightTiles()).toEqual([tile]);
    tile.destroy();
  });
});
