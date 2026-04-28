import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../../ui/field";
import { Switch } from "../../ui/switch";

type DebugSettingsProps = {
  devMode: boolean;
  onToggleDevMode: () => void;
};

export function DebugSettings({
  devMode,
  onToggleDevMode,
}: DebugSettingsProps) {
  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="development-mode">Development Mode</FieldLabel>
          <FieldDescription>
            Show development diagnostics while working on the canvas.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="development-mode"
          checked={devMode}
          onCheckedChange={onToggleDevMode}
        />
      </Field>
    </FieldGroup>
  );
}
