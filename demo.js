// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-javascript"],
  viewport: { width: 1100, height: 390 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("editing/measurements.txt");
    await lumine.project.setPaths([fixture("editing")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Select a rectangular column across several lines.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          lumine.views.getView(state.editor).blur();
          lumine.views.getView(state.editor).focus();
          lumine.commands.dispatch(lumine.views.getView(state.editor), "column-selection:sticky");
        }
      },
      drag({ state }) {
        const editor = state.editor.getElement();
        const rect = editor.getBoundingClientRect();
        const gutter = editor.querySelector(".gutter-container").getBoundingClientRect().width;
        const start = editor.pixelPositionForBufferPosition([1, 9]);
        const end = editor.pixelPositionForBufferPosition([4, 13]);
        return [
          rect.x + gutter + start.left + 1,
          rect.y + start.top + 10,
          rect.x + gutter + end.left + 1,
          rect.y + end.top + 10,
        ];
      },
      ready(context) {
        const { state } = context;
        return Boolean(state.editor.getSelections().length >= 4);
      },
    },
  ],
  async cleanup(context) {
    const { lumine } = context;
    lumine.commands.dispatch(lumine.workspace.getElement(), "column-selection:sticky");
  },
};
