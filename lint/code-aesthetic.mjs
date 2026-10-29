// Lint rules for names (the code-aesthetic skill, CODE_STYLE.md) that Oxlint has no built-in rule for. Loaded by
// vite.config.ts as the JS plugin "aesthetic"; the rules run inside `vp lint` like any other.

/** Abbreviations to spell out; a camelCase name is checked word by word (`errMsg` → `err`, `msg`). */
const ABBREVIATIONS = {
  cfg: "configuration",
  conf: "configuration",
  req: "request",
  res: "response",
  msg: "message",
  msgs: "messages",
  btn: "button",
  idx: "index",
  tmp: "temporary",
  val: "value",
  vals: "values",
  obj: "object",
  arr: "array",
  str: "text",
  num: "number",
  fn: "a name for what it does",
  cb: "a name for what it does",
  el: "element",
  evt: "event",
  err: "error",
  errs: "errors",
  ctx: "context",
  opts: "options",
  prev: "previous",
  cur: "current",
  curr: "current",
  len: "length",
  cnt: "count",
  mgr: "manager",
  svc: "service",
  impl: "implementation",
  util: "a descriptive name",
  utils: "a descriptive name",
};
const SHORT_ALLOWED = new Set(["_", "i", "j", "x", "y"]);

const words = (name) =>
  name
    .replace(/^_+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_]+/);

/** The identifiers a declaration introduces (destructuring patterns included). */
function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern];
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames);
  if (pattern.type === "ObjectPattern")
    return pattern.properties.flatMap((p) => bindingNames(p.type === "Property" ? p.value : p));
  if (pattern.type === "TSParameterProperty") return bindingNames(pattern.parameter);
  return [];
}

/** Each declared name with whether a single letter is fine there (loop index, one-expression lambda). */
function declarations(visit) {
  return {
    VariableDeclarator(node) {
      const loop = node.parent?.parent;
      const inForHead = loop && ["ForStatement", "ForInStatement", "ForOfStatement"].includes(loop.type);
      for (const id of bindingNames(node.id)) visit(id, inForHead);
    },
    ":function"(node) {
      if (node.id) visit(node.id, false);
      const tinyLambda = node.type === "ArrowFunctionExpression" && node.expression;
      for (const param of node.params) for (const id of bindingNames(param)) visit(id, tinyLambda);
    },
    CatchClause(node) {
      for (const id of bindingNames(node.param)) visit(id, false);
    },
    ClassDeclaration(node) {
      if (node.id) visit(node.id, false);
    },
  };
}

export default {
  meta: { name: "aesthetic" },
  rules: {
    "no-single-letter": {
      meta: { docs: { description: "Single-letter names only for loop indexes, x/y and one-expression lambdas" } },
      create(context) {
        return declarations((id, shortIsFine) => {
          if (id.name.length !== 1 || SHORT_ALLOWED.has(id.name) || shortIsFine) return;
          context.report({
            node: id,
            message: `\`${id.name}\` lives across lines: give it a name that says what it is.`,
          });
        });
      },
    },
    "no-abbreviations": {
      meta: { docs: { description: "Spell names out (request, response, context, error, message, …)" } },
      create(context) {
        return declarations((id) => {
          const short = words(id.name).find((w) => w in ABBREVIATIONS);
          if (short)
            context.report({ node: id, message: `\`${id.name}\`: write \`${short}\` as ${ABBREVIATIONS[short]}.` });
        });
      },
    },
    "no-utils-module": {
      meta: { docs: { description: "No utils/helpers modules: name a module for what it does" } },
      create(context) {
        return {
          Program(node) {
            if (/(^|[/\\])(utils?|helpers?)\.[cm]?[jt]sx?$/.test(context.filename ?? ""))
              context.report({
                node,
                message: "A utils/helpers module: move each function to the type or a module named for what it does.",
              });
          },
        };
      },
    },
  },
};
