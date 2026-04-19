import InfiniteCanvas from "./InfiniteCanvas";
import { Toaster } from "./components/ui/sonner";

function App() {
  return (
    <>
      <InfiniteCanvas />
      <Toaster closeButton position="bottom-right" richColors />
    </>
  );
}

export default App;
