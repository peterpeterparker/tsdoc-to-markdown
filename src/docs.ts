import type {
  ArrowFunction,
  CompilerOptions,
  Declaration,
  FunctionDeclaration,
  JSDocTagInfo,
  Node,
  Signature,
  Symbol as TypeScriptSymbol,
  TypeChecker,
  VariableDeclaration,
  VariableStatement
} from 'typescript';
import {
  createProgram,
  displayPartsToString,
  forEachChild,
  getCombinedModifierFlags,
  isArrowFunction,
  isClassDeclaration,
  isFunctionDeclaration,
  isMethodDeclaration,
  isModuleDeclaration,
  isVariableStatement,
  ModifierFlags,
  SyntaxKind
} from 'typescript';

export interface DocEntry {
  name: string;
  fileName?: string;
  documentation?: string;
  type?: string;
  constructors?: Pick<DocEntry, 'parameters' | 'returnType' | 'documentation'>[];
  parameters?: DocEntry[];
  methods?: DocEntry[];
  returnType?: string;
  jsDocs?: JSDocTagInfo[];
}

/** Serialize a symbol into a json object */
const serializeSymbol = ({
  checker,
  symbol
}: {
  checker: TypeChecker;
  symbol: TypeScriptSymbol;
}): DocEntry => {
  return {
    name: symbol.getName(),
    documentation: displayPartsToString(symbol.getDocumentationComment(checker)),
    type: checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!)),
    jsDocs: symbol.getJsDocTags()
  };
};

/** Serialize a class symbol information */
const serializeClass = ({
  checker,
  symbol
}: {
  checker: TypeChecker;
  symbol: TypeScriptSymbol;
}): DocEntry => {
  const details = serializeSymbol({checker, symbol});

  // Get the construct signatures
  const constructorType = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!);
  details.constructors = constructorType
    .getConstructSignatures()
    .map((signature: Signature) => serializeSignature({checker, signature}));
  return details;
};

/** True if this is visible outside this file, false otherwise */
const isNodeExportedOrPublic = (node: Node): boolean => {
  const flags = getCombinedModifierFlags(node as Declaration);
  return (flags & ModifierFlags.Export) !== 0 || (flags & ModifierFlags.Public) !== 0;
};

/** Serialize a signature (call or construct) */
const serializeSignature = ({
  checker,
  signature
}: {
  checker: TypeChecker;
  signature: Signature;
}): Pick<DocEntry, 'parameters' | 'returnType' | 'documentation'> => {
  return {
    parameters: signature.parameters.map((symbol: TypeScriptSymbol) =>
      serializeSymbol({checker, symbol})
    ),
    returnType: checker.typeToString(signature.getReturnType()),
    documentation: displayPartsToString(signature.getDocumentationComment(checker))
  };
};

// https://stackoverflow.com/a/73338964/5404186
const findDescendantArrowFunction = (node: Node): Node | undefined => {
  if (isArrowFunction(node)) {
    return node;
  }

  return forEachChild(node, findDescendantArrowFunction);
};

/** visit nodes finding exported classes */
const visit = ({checker, node}: {checker: TypeChecker; node: Node}): DocEntry[] => {
  // // Only consider exported nodes
  if (!isNodeExportedOrPublic(node)) {
    return [];
  }

  const entries: DocEntry[] = [];

  const addDocEntry = (symbol: TypeScriptSymbol | undefined) => {
    if (!symbol) {
      return;
    }

    const details = serializeSymbol({checker: checker, symbol});
    entries.push(details);
  };

  if (isClassDeclaration(node) && node.name) {
    // This is a top level class, get its symbol
    const symbol = checker.getSymbolAtLocation(node.name);

    if (symbol) {
      const classEntry: DocEntry = {
        ...serializeClass({checker: checker, symbol}),
        methods: []
      };

      const visitChild = (node: Node) => {
        const docEntries: DocEntry[] = visit({node, checker});
        classEntry.methods?.push(...docEntries);
      };

      forEachChild(node, visitChild);

      entries.push(classEntry);
    }
  } else if (isModuleDeclaration(node)) {
    const visitChild = (node: Node) => {
      const docEntries: DocEntry[] = visit({node, checker});
      entries.push(...docEntries);
    };

    // This is a namespace, visit its children
    forEachChild(node, visitChild);
  } else if (isMethodDeclaration(node)) {
    const symbol = checker.getSymbolAtLocation(node.name);
    addDocEntry(symbol);
  } else if (isFunctionDeclaration(node)) {
    const symbol = checker.getSymbolAtLocation((node as FunctionDeclaration).name ?? node);
    addDocEntry(symbol);
  } else if (isVariableStatement(node)) {
    const {
      declarationList: {declarations}
    } = node as VariableStatement;

    // TODO: not sure what's the proper casting, VariableDeclaration does not contain Symbol but the test entity effectively does
    const symbol = (declarations[0] as unknown as {symbol: TypeScriptSymbol}).symbol;
    addDocEntry(symbol);
  } else {
    const arrowFunc: Node | undefined = findDescendantArrowFunction(node);

    if (arrowFunc !== undefined) {
      const symbol = checker.getSymbolAtLocation(
        ((arrowFunc as ArrowFunction).parent as VariableDeclaration).name
      );
      addDocEntry(symbol);
    }
  }

  return entries;
};

export const generateDocumentation = ({
  fileNames,
  options
}: {
  fileNames: string[];
  options: CompilerOptions;
}): DocEntry[] => {
  // Build a program using the set of root file names in fileNames
  const program = createProgram(fileNames, options);

  // Get the checker, we will use it to find more about classes
  const checker = program.getTypeChecker();

  const sourceFiles = program.getSourceFiles().filter(({isDeclarationFile}) => !isDeclarationFile);

  const result: DocEntry[] = [];

  // Visit every sourceFile in the program
  for (const sourceFile of sourceFiles) {
    // Walk the tree to search for classes
    forEachChild(sourceFile, (node: Node) => {
      const entries: DocEntry[] = visit({checker, node});
      result.push(...entries.map((entry: DocEntry) => ({...entry, fileName: sourceFile.fileName})));
    });
  }

  return result;
};
