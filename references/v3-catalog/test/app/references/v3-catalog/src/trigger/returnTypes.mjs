import {
  task
} from "../../../../chunk-E2WZMITO.mjs";
import "../../../../chunk-TJGTO6YJ.mjs";
import "../../../../chunk-2X26PNN2.mjs";
import "../../../../chunk-NENC26SH.mjs";
import {
  init_esm
} from "../../../../chunk-CNFPS2CV.mjs";

// src/trigger/returnTypes.ts
init_esm();
var returnAllTypes = task({
  id: "return-all-types",
  run: async () => {
    const resultString = await returnString.triggerAndWait();
    const resultNumber = await returnNumber.triggerAndWait();
    const resultTrue = await returnTrue.triggerAndWait();
    const resultFalse = await returnFalse.triggerAndWait();
    const resultNull = await returnNull.triggerAndWait();
    const resultUndefined = await returnUndefined.triggerAndWait();
    const resultObject = await returnObject.triggerAndWait();
    const resultArray = await returnArray.triggerAndWait();
    return {
      resultString,
      resultNumber,
      resultTrue,
      resultFalse,
      resultNull,
      resultUndefined,
      resultObject,
      resultArray
    };
  }
});
var returnString = task({
  id: "return-string",
  run: async () => {
    return "This is a string";
  }
});
var returnNumber = task({
  id: "return-number",
  run: async () => {
    return 46;
  }
});
var returnTrue = task({
  id: "return-true",
  run: async () => {
    return true;
  }
});
var returnFalse = task({
  id: "return-false",
  run: async () => {
    return false;
  }
});
var returnNull = task({
  id: "return-null",
  run: async () => {
    return null;
  }
});
var returnUndefined = task({
  id: "return-undefined",
  run: async () => {
    return void 0;
  }
});
var returnObject = task({
  id: "return-object",
  run: async () => {
    return { key: "value" };
  }
});
var returnArray = task({
  id: "return-array",
  run: async () => {
    return [1, 2, 3];
  }
});
export {
  returnAllTypes,
  returnArray,
  returnFalse,
  returnNull,
  returnNumber,
  returnObject,
  returnString,
  returnTrue,
  returnUndefined
};
//# sourceMappingURL=returnTypes.mjs.map
