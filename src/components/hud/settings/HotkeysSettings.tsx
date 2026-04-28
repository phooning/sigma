import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../../ui/field";
import { HOTKEY_ROWS } from "../constants";

export function HotkeysSettings() {
  return (
    <FieldGroup>
      {HOTKEY_ROWS.map((hotkey) => (
        <Field key={hotkey.keys} orientation="responsive">
          <FieldContent>
            <FieldLabel>{hotkey.keys}</FieldLabel>
            <FieldDescription>{hotkey.description}</FieldDescription>
          </FieldContent>
        </Field>
      ))}
    </FieldGroup>
  );
}
