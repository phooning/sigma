import type { CanvasBackgroundPattern } from "../../../stores/useSettingsStore";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../../ui/field";
import { ToggleGroup, ToggleGroupItem } from "../../ui/toggle-group";

type AppearanceSettingsProps = {
  canvasBackgroundPattern: CanvasBackgroundPattern;
  onCanvasBackgroundPatternChange: (value: CanvasBackgroundPattern) => void;
};

export function AppearanceSettings({
  canvasBackgroundPattern,
  onCanvasBackgroundPatternChange,
}: AppearanceSettingsProps) {
  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>Canvas Background</FieldLabel>
          <FieldDescription>
            Choose the marker style for navigating the canvas.
          </FieldDescription>
        </FieldContent>
        <ToggleGroup
          type="single"
          value={canvasBackgroundPattern}
          onValueChange={(value) => {
            if (value) {
              onCanvasBackgroundPatternChange(value as CanvasBackgroundPattern);
            }
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="dots" aria-label="Dots background">
            Dots
          </ToggleGroupItem>
          <ToggleGroupItem value="grid" aria-label="Grid background">
            Grid
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>
    </FieldGroup>
  );
}
