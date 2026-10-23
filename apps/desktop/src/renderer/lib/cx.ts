export function cx(
  ...values: readonly (string | false | null | undefined)[]
): string {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}
