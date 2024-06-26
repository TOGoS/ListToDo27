# List To-Do 27

Filters a database (in the form of a [TEF file](http://github.com/TOGoS/TEF)) of tasks and projects.

Can pass through all items read, or randomly pick a suitable task for you to work on next.

Can transform the list to JSON or a prettified TEF-like format.

For video demonstration of usage, which includes using the tool to improve itself, see:
- [SynthGen Update #5 : list-todo.ts](https://youtu.be/SiKqzO_wIho)
- [SynthGen Update #5 Part 2: ListToDo27 Workflow Demonstration](https://youtu.be/UqLWNpEVnhM)

## Input File Format

```tef
=project FRIZZULATOR

Description of Frizzulator project goes here.

=task SOME-OTHER-TASK-1
title: Set up Frizzulator project on GitHub
# Tasks don't have to be part of a parent task or project,
# but they may be, if that helps you organize things.
# In -p mode, parent tasks/projects will also be printed for context.
subtask-of: FRIZZULATOR
status: done

=task SOME-OTHER-TASK-2
title: Write a cool README
subtask-of: FRIZZULATOR
status: todo

=task SOME-OPAQUE-TASK-ID-123
title: Make initial Frizzulator commit and push to GitHub
subtask-of: FRIZZULATOR
status: todo
# Because this task deends on others,
# list-todo won't treat it as 'shovel-ready' until those other tasks are done.
depends-on: SOME-OTHER-TASK-1, SOME-OTHER-TASK-2

This task won't show up when you `list-todo -r` until
SOME-OTHER-TASK-1 and SOME-OTHER-TASK-2 have `status: done`.
```

## Common Usage

Cat a bunch of to-do lists together and have list-todo pick a task for you
and print it out pretty:

```sh
clear && cat my-todo-list.tef /some/other/todo-list.tef | deno run https://deno.land/x/listtodo27@v0.1.3/list-todo.ts -p
```
