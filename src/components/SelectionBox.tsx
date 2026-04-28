export interface ISelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

const SelectionBox = ({ selectionBox }: { selectionBox: ISelectionBox }) => {
  return (
    <div
      className="selection-box"
      style={{
        left: Math.min(selectionBox.startX, selectionBox.endX),
        top: Math.min(selectionBox.startY, selectionBox.endY),
        width: Math.abs(selectionBox.endX - selectionBox.startX),
        height: Math.abs(selectionBox.endY - selectionBox.startY),
      }}
    />
  );
};

export { SelectionBox };
