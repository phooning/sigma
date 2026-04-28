import { Toaster } from "./components/ui/sonner";
import InfiniteCanvas from "./InfiniteCanvas";

function App() {
  return (
    <>
      <InfiniteCanvas />
      <Toaster closeButton position="bottom-right" richColors />
    </>
  );
}

export default App;
