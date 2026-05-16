import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from "../../ui/field";

export function AboutSettings() {
  return (
    <FieldGroup>
      <Field>
        <FieldTitle>
          Developed with daily use for usability and performance.
        </FieldTitle>
        <FieldDescription>
          <a
            href="https://github.com/phooning/sigma"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-4"
          >
            Source code
          </a>
        </FieldDescription>
      </Field>

      <p className="mt-4 text-sm text-muted-foreground">SIGMA Canvas Studio</p>
    </FieldGroup>
  );
}
