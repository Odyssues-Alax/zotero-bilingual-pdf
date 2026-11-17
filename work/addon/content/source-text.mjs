// An @ in a core-shell material (Te@Bi) is not an email address.
export const containsEmail=text=>/[A-Z0-9._%+-]+\s*@\s*[A-Z0-9-]+(?:\s*\.\s*[A-Z0-9-]+)*\s*\.\s*[A-Z]{2,}(?![A-Z0-9])/i.test(text);
