import {
  init_esm
} from "./chunk-CNFPS2CV.mjs";

// ../../node_modules/.pnpm/uncrypto@0.1.3/node_modules/uncrypto/dist/crypto.node.mjs
init_esm();
import nodeCrypto from "crypto";
var subtle = nodeCrypto.webcrypto?.subtle || {};
var randomUUID = () => {
  return nodeCrypto.randomUUID();
};
var getRandomValues = (array) => {
  return nodeCrypto.webcrypto.getRandomValues(array);
};
var _crypto = {
  randomUUID,
  getRandomValues,
  subtle
};

export {
  subtle,
  randomUUID,
  getRandomValues,
  _crypto
};
//# sourceMappingURL=chunk-TJGTO6YJ.mjs.map
