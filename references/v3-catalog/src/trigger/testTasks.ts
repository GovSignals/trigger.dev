import { task } from "@trigger.dev/sdk/v3"

export const taskTask1 = task({
  id: "task-task-1",
  run: async () => {
    return "foo-task-task-1-bar";
  },
});


export const taskTask2 = task({
  id: "task-task-2",
  run: async () => {
    return "foo-task-task-2-bar";
  },
});
