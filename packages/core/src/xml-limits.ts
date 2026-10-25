import { Consts, KdbxError } from "@keenext/kdbxweb";
import { INPUT_LIMITS } from "./preflight.js";

export interface XmlLimits {
  xmlChars: number;
  xmlElements: number;
  xmlDepth: number;
}

function limit(message: string): never {
  throw new KdbxError(Consts.ErrorCodes.ResourceLimit, message);
}

function malformed(message: string): never {
  throw new KdbxError(Consts.ErrorCodes.FileCorrupt, message);
}

/**
 * Linear pre-scan run before any DOM is built. It counts elements and nesting depth
 * without allocating per node, and rejects DTDs (KeePass never writes them), so entity
 * expansion cannot occur. Well-formedness is still left to the XML parser.
 */
export function scanXml(xml: string, limits: XmlLimits = INPUT_LIMITS): void {
  if (xml.length > limits.xmlChars) limit("Decrypted XML exceeds the size limit.");
  const skip = (from: number, terminator: string): number => {
    const end = xml.indexOf(terminator, from);
    if (end === -1) malformed("Unterminated XML markup.");
    return end + terminator.length;
  };
  let elements = 0;
  let depth = 0;
  let index = xml.indexOf("<");
  while (index !== -1) {
    if (xml.startsWith("<!--", index)) {
      index = skip(index + 4, "-->");
    } else if (xml.startsWith("<![CDATA[", index)) {
      index = skip(index + 9, "]]>");
    } else if (xml.startsWith("<?", index)) {
      index = skip(index + 2, "?>");
    } else if (xml.startsWith("<!", index)) {
      malformed("XML document type declarations are not supported.");
    } else if (xml.startsWith("</", index)) {
      depth--;
      index = skip(index + 2, ">");
    } else {
      if (++elements > limits.xmlElements) limit("Decrypted XML has too many elements.");
      // Attribute values may contain '>' but never '<'.
      let end = index + 1;
      let quote = 0;
      for (; end < xml.length; end++) {
        const code = xml.charCodeAt(end);
        if (quote) {
          if (code === quote) quote = 0;
        } else if (code === 0x22 || code === 0x27) {
          quote = code;
        } else if (code === 0x3e) {
          break;
        }
      }
      if (end === xml.length) malformed("Unterminated XML start tag.");
      if (xml.charCodeAt(end - 1) !== 0x2f && ++depth > limits.xmlDepth) {
        limit("Decrypted XML is nested too deeply.");
      }
      index = end + 1;
    }
    index = xml.indexOf("<", index);
  }
}
