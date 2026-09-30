// extension/pii-patterns.js
var PII_PATTERNS = [
  { name: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,7}\b/gi, placeholder: "[EMAIL]" },
  { name: "phone", regex: /(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{4}[-\s]?\d{5}(?!\d)|(?<!\d)\+?1[-.\s]?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}(?!\d)/g, placeholder: "[PHONE]" },
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g, placeholder: "[SSN]" },
  { name: "credit_card", regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{16}\b/g, placeholder: "[CREDIT_CARD]" },
  { name: "aadhaar", regex: /\b[2-9]\d{3}[-\s]?\d{4}[-\s]?\d{4}\b/g, placeholder: "[AADHAAR]" },
  { name: "pan", regex: /\b[A-Z]{5}\d{4}[A-Z]\b/gi, placeholder: "[PAN]" },
  { name: "dob", regex: /\b(0?[1-9]|[12]\d|3[01])[-\/.](0?[1-9]|1[0-2])[-\/.](19|20)\d{2}\b/g, placeholder: "[DOB]" }
];