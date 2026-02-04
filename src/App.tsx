import "./App.css";
import MilkdownEditorDemo from "./components/MilkdownEditor";

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">Milkdown Split Editor</div>
        <div className="app-subtitle">
          左: Markdown / 右: WYSIWYG（plugin-listener + replaceAllで双方向同期）
        </div>
      </header>
      <main className="app-main">
        <MilkdownEditorDemo />
      </main>
    </div>
  );
}

export default App;
