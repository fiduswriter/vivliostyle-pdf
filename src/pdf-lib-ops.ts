// @ts-nocheck
/**
 * Re-export low-level @pdfme/pdf-lib helpers that are present in the bundled
 * JS but omitted from the published type declarations.
 */
export {
    PDFNumber,
    PDFOperator,
    concatTransformationMatrix,
    popGraphicsState,
    pushGraphicsState
} from "@pdfme/pdf-lib"

/** Operator names used when building PDFOperator instances. */
export const OperatorNames = {
    PushGraphicsState: "q",
    PopGraphicsState: "Q",
    ConcatTransformationMatrix: "cm"
} as const
