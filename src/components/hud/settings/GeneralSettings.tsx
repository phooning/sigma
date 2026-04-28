import { Button } from "../../ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../../ui/field";

type GeneralSettingsProps = {
  screenshotDirectory: string;
  onChooseScreenshotDirectory: () => void;
  onClearScreenshotDirectory: () => void;
};

export function GeneralSettings({
  screenshotDirectory,
  onChooseScreenshotDirectory,
  onClearScreenshotDirectory,
}: GeneralSettingsProps) {
  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>Screenshot Directory</FieldLabel>
          <FieldDescription className="truncate">
            {screenshotDirectory ||
              "Choose a folder before the first screenshot."}
          </FieldDescription>
        </FieldContent>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onChooseScreenshotDirectory}
          >
            Choose
          </Button>
          {screenshotDirectory ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClearScreenshotDirectory}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </Field>
    </FieldGroup>
  );
}
