describe("column-selection", () => {
  it("activates and deactivates cleanly", async () => {
    await atom.packages.activatePackage("column-selection");
    expect(atom.packages.isPackageActive("column-selection")).toBe(true);
    await atom.packages.deactivatePackage("column-selection");
    expect(atom.packages.isPackageActive("column-selection")).toBe(false);
  });
});
