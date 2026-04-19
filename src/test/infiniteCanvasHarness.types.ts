export type DropEventPayload = {
  payload: {
    type: 'drop';
    paths: string[];
  };
};

export type DropCallback = (event: DropEventPayload) => void;

export type ViewportSize = {
  width?: number;
  height?: number;
};
