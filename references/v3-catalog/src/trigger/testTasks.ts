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


export const taskTask3 = task({
  id: "task-task-3",
  run: async () => {
    return "foo-task-task-3-bar";
  },
});

export const taskTask4 = task({
  id: "task-task-4",
  run: async () => {
    return "foo-task-task-4-bar";
  },
});

export const taskTask5 = task({
  id: "task-task-5",
  run: async () => {
    return "foo-task-task-5-bar";
  },
});
