import type { EntryDetails, EntryFieldEdit, EntrySummary, GroupSummary } from "@vscode-kdbx/core";
import { isEntryDetails, isRecord, isUiState } from "./editor-protocol.js";
import type { EditorAction, EditorRequest, UiState } from "./editor-protocol.js";

declare function acquireVsCodeApi(): { postMessage(message: EditorRequest): void };

interface FieldDraft {
  value: string;
  protected: boolean;
  changed: boolean;
}

const standardFields = ["Title", "UserName", "Password", "URL", "Notes"];

export function entryMatchesSearch(
  entry: EntrySummary,
  query: string,
  groups: readonly GroupSummary[],
): boolean {
  const names = new Map(groups.map((group) => [group.id, group]));
  const path: string[] = [];
  const visited = new Set<string>();
  let id: string | null = entry.groupId;
  while (id && !visited.has(id)) {
    visited.add(id);
    const group = names.get(id);
    if (!group) break;
    path.push(group.name);
    id = group.parentId;
  }
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const searchable = [
    entry.title,
    entry.username,
    entry.url,
    ...entry.tags,
    path.reverse().join("/"),
  ]
    .join("\n")
    .toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
}

export function changedFields(
  fields: ReadonlyMap<string, FieldDraft>,
): Record<string, EntryFieldEdit> {
  // A null prototype also makes custom fields named "__proto__" ordinary data.
  const result: Record<string, EntryFieldEdit> = Object.create(null) as Record<
    string,
    EntryFieldEdit
  >;
  for (const [name, field] of fields) {
    if (field.changed) result[name] = { value: field.value, protected: field.protected };
  }
  return result;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function start(): void {
  const api = acquireVsCodeApi();
  const channelValue = document.body.dataset.channel;
  const app = document.getElementById("app");
  if (!channelValue || !app) return;
  const channel: string = channelValue;
  let nextId = 0;
  let lastReply = 0;
  let epoch = 0;
  let selectionVersion = 0;
  let state: UiState | undefined;
  let selectedGroup = "";
  const collapsedGroups = new Set<string>();
  let selectedId = "";
  let details: EntryDetails | undefined;
  let fields = new Map<string, FieldDraft>();
  const removed = new Set<string>();
  let dirtyDraft = false;
  let editing = false;
  let committing = false;
  let draftVersion = 0;
  let search = "";
  let guardAction: (() => void) | undefined;
  let detailsForm: HTMLFormElement | undefined;
  let tagsInput: HTMLInputElement | undefined;
  let entryGroup: HTMLSelectElement | undefined;
  let draftNotice: HTMLParagraphElement | undefined;
  let visibleStatus = "";
  let lastActivity = 0;
  const pending = new Map<
    number,
    {
      epoch: number;
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const concealTimers = new Set<ReturnType<typeof setTimeout>>();
  const secretCleanups = new Set<() => void>();
  const heading = element("h1", "KeePass database");
  const status = element("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const error = element("p");
  error.className = "notice error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const flags = element("p");
  flags.className = "notice";
  const guard = element("section");
  guard.className = "panel";
  guard.setAttribute("aria-label", "Finish editing");
  guard.hidden = true;
  const locked = element("section");
  locked.className = "panel locked";
  locked.setAttribute("aria-label", "Unlock database");
  const unlocked = element("section");
  const toolbar = element("div");
  toolbar.className = "toolbar";
  toolbar.setAttribute("role", "group");
  toolbar.setAttribute("aria-label", "Database actions");
  const layout = element("div");
  layout.className = "layout";
  const groupsPanel = element("section");
  groupsPanel.className = "panel groups-panel";
  const entriesPanel = element("section");
  entriesPanel.className = "panel entries-panel";
  const detailPanel = element("section");
  detailPanel.id = "details";
  detailPanel.className = "panel";
  detailPanel.setAttribute("aria-label", "Entry details");
  layout.append(groupsPanel, entriesPanel, detailPanel);
  unlocked.append(toolbar, layout);
  app.replaceChildren(heading, status, error, flags, guard, locked, unlocked);

  function notify(message: string, failure = false): void {
    if (failure) {
      error.textContent = message;
      error.hidden = false;
    } else {
      visibleStatus = message;
      status.textContent = message;
    }
  }

  function run(work: () => Promise<unknown>): void {
    void work().catch((reason: unknown) => {
      notify(reason instanceof Error ? reason.message : "The operation failed.", true);
    });
  }

  function request(action: EditorAction): Promise<unknown> {
    if (document.hidden && action.kind !== "activity")
      return Promise.reject(new Error("Return to the editor to continue."));
    const writes = [
      "createGroup",
      "renameGroup",
      "moveGroup",
      "deleteGroup",
      "createEntry",
      "duplicateEntry",
      "updateEntry",
      "deleteEntry",
      "restoreHistory",
      "importAttachment",
      "removeAttachment",
      "renameAttachment",
      "changePassword",
      "generate",
      "undo",
      "redo",
      "save",
    ];
    if (writes.includes(action.kind) && !editable())
      return Promise.reject(new Error("The database is busy, locked, or read-only."));
    if (action.kind !== "activity") error.hidden = true;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The operation has not responded. Refresh the editor before retrying."));
      }, 120_000);
      pending.set(id, { epoch, resolve, reject, timer });
      api.postMessage({ channel, id, action });
    });
  }

  function cancelPending(): void {
    epoch++;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new Error("Pending operation cleared for security; its host operation may still finish."),
      );
    }
    pending.clear();
  }

  function clearSecrets(): void {
    for (const timer of concealTimers) clearTimeout(timer);
    concealTimers.clear();
    for (const cleanup of secretCleanups) cleanup();
    secretCleanups.clear();
    for (const node of app!.querySelectorAll<HTMLInputElement>("input[type=password]"))
      node.value = "";
  }

  function clearDetails(): void {
    clearSecrets();
    selectionVersion++;
    details = undefined;
    for (const field of fields.values()) field.value = "";
    fields.clear();
    removed.clear();
    dirtyDraft = false;
    editing = false;
    draftVersion++;
    detailsForm = undefined;
    tagsInput = undefined;
    entryGroup = undefined;
    draftNotice = undefined;
    guardAction = undefined;
    guard.hidden = true;
    detailPanel.replaceChildren(
      element("h2", "Your credentials, at a glance"),
      element("p", "Select an entry to view and copy its credentials, or add a new entry."),
    );
  }

  function button(text: string, action: () => void, disabled = false): HTMLButtonElement {
    const node = element("button", text);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
  }

  function readButton(text: string, action: () => void): HTMLButtonElement {
    const node = button(text, action, !!state?.busy);
    node.dataset.readAction = "true";
    return node;
  }

  function iconButton(
    icon: string,
    label: string,
    action: () => void,
    disabled = false,
  ): HTMLButtonElement {
    const node = button(icon, action, disabled);
    node.className = "icon-button";
    node.setAttribute("aria-label", label);
    node.title = label;
    return node;
  }

  function disclosure(label: string, className = ""): HTMLDetailsElement {
    const node = element("details");
    node.className = className;
    node.append(element("summary", label));
    return node;
  }

  function actionMenu(label: string): HTMLDetailsElement {
    const menu = disclosure(label, "action-menu");
    const items = element("div");
    items.className = "menu-items";
    menu.append(items);
    menu.addEventListener("click", (event) => {
      if (event.target instanceof HTMLButtonElement) menu.open = false;
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        menu.open = false;
        menu.querySelector("summary")?.focus();
      }
    });
    return menu;
  }

  let controlId = 0;
  function labelControl<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    parent: HTMLElement,
    label: string,
    control: T,
  ): T {
    control.id = `control-${++controlId}`;
    const caption = element("label", label);
    caption.htmlFor = control.id;
    parent.append(caption, control);
    return control;
  }

  function input(parent: HTMLElement, label: string, value = "", type = "text"): HTMLInputElement {
    const node = element("input");
    node.type = type;
    node.value = value;
    node.autocomplete = "off";
    return labelControl(parent, label, node);
  }

  function checkbox(parent: HTMLElement, label: string, checked: boolean): HTMLInputElement {
    const caption = element("label");
    caption.className = "inline";
    const node = element("input");
    node.type = "checkbox";
    node.checked = checked;
    caption.append(node, document.createTextNode(label));
    parent.append(caption);
    return node;
  }

  function groupSelect(parent: HTMLElement, label: string, current: string): HTMLSelectElement {
    const select = element("select");
    for (const group of state?.groups ?? []) {
      const option = element("option", groupPath(group.id));
      option.value = group.id;
      select.append(option);
    }
    select.value = current;
    return labelControl(parent, label, select);
  }

  function groupPath(id: string): string {
    const path: string[] = [];
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
      visited.add(id);
      const group = state?.groups.find((item) => item.id === id);
      if (!group) break;
      path.unshift(group.name || "(unnamed)");
      id = group.parentId ?? "";
    }
    return path.join(" / ");
  }

  function editable(): boolean {
    return !!state && !state.locked && !state.readOnly && !state.busy;
  }

  function markDraft(): void {
    dirtyDraft = true;
    draftVersion++;
    if (draftNotice)
      draftNotice.textContent = "Editing · Done keeps your changes. Cancel discards this edit.";
  }

  async function applyDraft(): Promise<boolean> {
    if (committing) return false;
    if (!details || !dirtyDraft) return true;
    if (!editable() || !detailsForm?.reportValidity() || !tagsInput || !entryGroup) return false;
    const version = draftVersion;
    const selected = selectedId;
    committing = true;
    updateDetailControls();
    let result: unknown;
    try {
      result = await request({
        kind: "updateEntry",
        id: details.id,
        fields: changedFields(fields),
        removeFields: [...removed],
        tags: tagsInput.value
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        groupId: entryGroup.value,
      });
    } finally {
      committing = false;
      updateDetailControls();
    }
    if (version !== draftVersion || selected !== selectedId) {
      notify("Your edit changed while finishing. Choose Done again before leaving.", true);
      return false;
    }
    dirtyDraft = false;
    removed.clear();
    notify("Entry updated. Press Ctrl+S (macOS: Cmd+S) to save the database.");
    if (isEntryDetails(result) && result.id === selectedId) showDetails(result);
    else await loadDetails(selectedId);
    return true;
  }

  function guarded(action: () => void): void {
    if (!dirtyDraft) {
      action();
      return;
    }
    guardAction = action;
    guard.replaceChildren(
      element("h2", "Finish editing?"),
      element("p", "Keep your changes with Done, or discard this edit before continuing."),
    );
    guard.append(
      button("Done and continue", () =>
        run(async () => {
          const next = guardAction;
          if (await applyDraft()) {
            guard.hidden = true;
            guardAction = undefined;
            next?.();
          }
        }),
      ),
      button("Discard edit and continue", () => {
        const next = guardAction;
        clearDetails();
        next?.();
      }),
      button("Keep editing", () => {
        guard.hidden = true;
        guardAction = undefined;
      }),
    );
    guard.hidden = false;
    guard.querySelector("button")?.focus();
  }

  async function loadDetails(id: string): Promise<void> {
    const version = ++selectionVersion;
    const draft = draftVersion;
    const result = await request({ kind: "details", id });
    if (
      version === selectionVersion &&
      draft === draftVersion &&
      !dirtyDraft &&
      id === selectedId &&
      !state?.locked &&
      !document.hidden
    ) {
      if (!isEntryDetails(result) || result.id !== id)
        throw new Error("The host returned invalid entry details.");
      showDetails(result);
    }
  }

  function selectEntry(id: string): void {
    guarded(() => {
      clearDetails();
      selectedId = id;
      renderEntries();
      run(async () => {
        await loadDetails(id);
        if (selectedId === id && details && window.matchMedia("(max-width: 950px)").matches)
          detailPanel.scrollIntoView({ block: "start" });
      });
    });
  }

  async function mutate(action: EditorAction, refreshDetails = true): Promise<void> {
    const id = selectedId;
    const result = await request(action);
    if (document.hidden || state?.locked) return;
    const resultId =
      typeof result === "string"
        ? result
        : isRecord(result) && typeof result.id === "string"
          ? result.id
          : undefined;
    if (["createEntry", "duplicateEntry"].includes(action.kind) && resultId) {
      clearDetails();
      selectedId = resultId;
      if (search || (selectedGroup && action.kind === "duplicateEntry")) {
        search = "";
        selectedGroup = "";
        renderGroups();
      }
      await loadDetails(resultId);
      if (action.kind === "createEntry" && details) showDetails(details, true);
    } else if (refreshDetails && id && id === selectedId) {
      if (isEntryDetails(result) && result.id === id) showDetails(result);
      else if (state?.entries.some((entry) => entry.id === id)) await loadDetails(id);
      else {
        clearDetails();
        selectedId = "";
      }
    }
    renderEntries();
    notify(state?.dirty ? "Unsaved database changes." : "No unsaved database changes.");
  }

  function renderLocked(becameLocked: boolean): void {
    const focusPassword =
      !locked.hidden &&
      (becameLocked || !locked.childElementCount || locked.contains(document.activeElement));
    const badge = element("span", "KeePass for VSCode");
    badge.className = "unlock-badge";
    const filename = element("p", state?.filename ?? "");
    filename.className = "unlock-filename";
    const description = element("p", "Enter your master password to access this database.");
    description.className = "muted";
    locked.replaceChildren(badge, element("h2", "Unlock your database"), filename, description);
    const form = element("form");
    form.className = "unlock-form";
    const password = input(form, "Master password", "", "password");
    password.maxLength = 16_384;
    password.autocomplete = "current-password";
    password.disabled = state?.busy ?? false;
    password.placeholder = "Enter master password";
    const hint = element("p", "Your database stays encrypted on disk. Unlocking happens locally.");
    hint.id = "unlock-hint";
    hint.className = "muted unlock-hint";
    password.setAttribute("aria-describedby", hint.id);
    const submit = element("button", state?.busy ? "Unlocking…" : "Unlock");
    submit.type = "submit";
    submit.className = "unlock-submit";
    submit.disabled = state?.busy ?? false;
    const actions = element("div");
    actions.className = "unlock-actions";
    const cancel = button("Cancel unlock", () => run(() => request({ kind: "cancelUnlock" })));
    cancel.className = "secondary-button";
    cancel.hidden = !state?.busy;
    actions.append(submit, cancel);
    form.append(hint, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = password.value;
      password.value = "";
      run(() => request({ kind: "unlock", password: value }));
    });
    const footer = element("div");
    footer.className = "unlock-footer";
    const create = button(
      "Create a new database…",
      () => run(() => request({ kind: "createDatabase" })),
      state?.busy ?? false,
    );
    create.className = "secondary-button";
    footer.append(element("span", "Starting fresh?"), create);
    locked.append(form, footer);
    if (focusPassword && !state?.busy) password.focus();
  }

  function renderToolbar(): void {
    toolbar.replaceChildren();
    const hint = element(
      "span",
      state?.dirty ? "Unsaved changes · Ctrl+S / Cmd+S" : "All changes saved",
    );
    hint.className = "muted";
    const menu = actionMenu("More database actions");
    const actions: Array<[string, EditorAction, boolean]> = [
      ["Save", { kind: "save" }, !editable() || !!state?.conflict],
      ["Save as…", { kind: "saveAs" }, !!state?.busy],
      ["Revert from disk…", { kind: "revert" }, !!state?.busy],
      ["Undo", { kind: "undo" }, !editable() || !state?.canUndo],
      ["Redo", { kind: "redo" }, !editable() || !state?.canRedo],
    ];
    for (const [label, action, disabled] of actions) {
      menu
        .querySelector(".menu-items")!
        .append(
          button(
            label,
            () =>
              guarded(() =>
                run(() => mutate(action, action.kind !== "save" && action.kind !== "saveAs")),
              ),
            disabled,
          ),
        );
    }
    menu.querySelector(".menu-items")!.append(
      button("Change master password…", () => guarded(showMasterPassword), !editable()),
      button(
        "New database…",
        () => guarded(() => run(() => request({ kind: "createDatabase" }))),
        !!state?.busy,
      ),
      button(
        "Refresh",
        () =>
          guarded(() =>
            run(async () => {
              await request({ kind: "refresh" });
              if (selectedId && !state?.locked) await loadDetails(selectedId);
            }),
          ),
        !!state?.busy,
      ),
    );
    toolbar.append(
      hint,
      menu,
      iconButton(
        "Lock",
        "Lock database",
        () => guarded(() => run(() => mutate({ kind: "lock" }, false))),
        !!state?.busy,
      ),
    );
  }

  function showMasterPassword(): void {
    clearDetails();
    detailPanel.replaceChildren(element("h2", "Change master password"));
    const form = element("form");
    const password = input(form, "New master password", "", "password");
    const confirmation = input(form, "Confirm new master password", "", "password");
    for (const control of [password, confirmation]) {
      control.required = true;
      control.maxLength = 16_384;
      control.autocomplete = "new-password";
    }
    const submit = element("button", "Change master password");
    submit.type = "submit";
    form.append(
      element("p", "The new password takes effect in memory. Save the database to persist it."),
      submit,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const action: EditorAction = {
        kind: "changePassword",
        password: password.value,
        confirmation: confirmation.value,
      };
      password.value = "";
      confirmation.value = "";
      run(async () => {
        await request(action);
        notify("Master password changed in memory. Save now with the new password.");
        clearDetails();
      });
    });
    form.append(button("Cancel", clearDetails));
    detailPanel.append(form);
    password.focus();
  }

  function renderGroups(): void {
    const header = element("div");
    header.className = "pane-heading";
    header.append(
      element("h2", "Groups"),
      iconButton(
        "+",
        "New group",
        () => guarded(() => showGroupEditor("create", selectedGroup)),
        !editable() || !state?.groups.length,
      ),
    );
    groupsPanel.replaceChildren(header);
    const all = button("All entries", () =>
      guarded(() => {
        selectedGroup = "";
        renderGroups();
        renderEntries();
      }),
    );
    all.className = "group-item";
    all.setAttribute("aria-pressed", String(!selectedGroup));
    groupsPanel.append(all);
    const list = element("ul");
    list.className = "group-list";
    list.setAttribute("aria-label", "Group hierarchy");
    const visited = new Set<string>();
    function add(group: GroupSummary, parent: HTMLUListElement): void {
      if (visited.has(group.id)) return;
      visited.add(group.id);
      const row = element("li");
      const control = button(
        `${group.name || "(unnamed)"}${group.recycleBin ? " (recycle bin)" : ""}`,
        () =>
          guarded(() => {
            selectedGroup = group.id;
            renderGroups();
            renderEntries();
          }),
      );
      control.className = "group-item";
      control.setAttribute("aria-pressed", String(selectedGroup === group.id));
      const line = element("div");
      line.className = "group-row";
      const menu = actionMenu(`Actions for ${group.name || "unnamed group"}`);
      menu.querySelector("summary")!.textContent = "…";
      menu
        .querySelector("summary")!
        .setAttribute("aria-label", `Actions for ${group.name || "unnamed group"}`);
      for (const [label, mode] of [
        ["New subgroup", "create"],
        ["Rename", "rename"],
        ["Move / restore…", "move"],
      ] as const) {
        menu
          .querySelector(".menu-items")!
          .append(
            button(
              label,
              () => guarded(() => showGroupEditor(mode, group.id)),
              !editable() || (mode === "move" && group.parentId === null),
            ),
          );
      }
      for (const permanent of [false, true]) {
        menu
          .querySelector(".menu-items")!
          .append(
            button(
              permanent ? "Permanently delete group…" : "Delete group…",
              () =>
                guarded(() =>
                  run(() => mutate({ kind: "deleteGroup", id: group.id, permanent }, false)),
                ),
              !editable() || group.parentId === null,
            ),
          );
      }
      line.append(control, menu);
      line.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        menu.open = true;
        menu.querySelector("button")?.focus();
      });
      row.append(line);
      const children = element("ul");
      for (const child of state?.groups ?? [])
        if (child.parentId === group.id) add(child, children);
      if (children.children.length) {
        children.id = `group-children-${++controlId}`;
        children.hidden = collapsedGroups.has(group.id);
        const toggle = iconButton(
          children.hidden ? "+" : "−",
          `Toggle ${group.name || "unnamed group"}`,
          () => {
            children.hidden = !children.hidden;
            if (children.hidden) collapsedGroups.add(group.id);
            else collapsedGroups.delete(group.id);
            toggle.textContent = children.hidden ? "+" : "−";
            toggle.setAttribute("aria-expanded", String(!children.hidden));
          },
        );
        toggle.setAttribute("aria-expanded", String(!children.hidden));
        toggle.setAttribute("aria-controls", children.id);
        line.prepend(toggle);
        row.append(children);
      }
      parent.append(row);
    }
    const groups = state?.groups ?? [];
    for (const group of groups)
      if (group.parentId === null || !groups.some((item) => item.id === group.parentId))
        add(group, list);
    for (const group of groups) if (!visited.has(group.id)) add(group, list);
    groupsPanel.append(list);
    if (!groups.length) groupsPanel.append(element("p", "No groups available."));
  }

  function showGroupEditor(mode: "create" | "rename" | "move", id: string): void {
    clearDetails();
    const group = state?.groups.find((item) => item.id === id);
    detailPanel.replaceChildren(
      element(
        "h2",
        mode === "create"
          ? "New group"
          : mode === "rename"
            ? "Rename group"
            : "Move / restore group",
      ),
    );
    const form = element("form");
    const name = input(form, "Group name", mode === "rename" ? group?.name : "");
    name.required = mode !== "move";
    name.maxLength = 4096;
    name.hidden = mode === "move";
    form.querySelector("label")!.hidden = mode === "move";
    const destination = groupSelect(
      form,
      mode === "create" ? "Parent group" : "Destination group",
      mode === "move" ? (group?.parentId ?? "") : id || state?.groups[0]?.id || "",
    );
    destination.hidden = mode === "rename";
    destination.labels?.forEach((label) => {
      label.hidden = mode === "rename";
    });
    if (mode === "move") {
      for (const option of destination.options) {
        let parent: string | null | undefined = option.value;
        const visited = new Set<string>();
        while (parent && !visited.has(parent)) {
          visited.add(parent);
          if (parent === id) {
            option.disabled = true;
            break;
          }
          parent = state?.groups.find((item) => item.id === parent)?.parentId;
        }
      }
    }
    const controls = element("div");
    controls.className = "actions";
    const submit = element("button", mode === "create" ? "Create group" : "Done");
    submit.type = "submit";
    submit.disabled = !editable();
    controls.append(submit, button("Cancel", clearDetails));
    form.append(controls);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (mode !== "move" && !name.value.trim()) {
        notify("Enter a group name.", true);
        name.focus();
        return;
      }
      const action: EditorAction =
        mode === "create"
          ? { kind: "createGroup", parentId: destination.value, name: name.value }
          : mode === "rename"
            ? { kind: "renameGroup", id, name: name.value }
            : { kind: "moveGroup", id, parentId: destination.value };
      run(async () => {
        await mutate(action, false);
        clearDetails();
      });
    });
    detailPanel.append(form);
    (mode === "move" ? destination : name).focus();
  }

  function renderEntries(): void {
    const previousSearch = entriesPanel.querySelector<HTMLInputElement>("[data-entry-search]");
    const restoreSearchFocus = !!previousSearch && document.activeElement === previousSearch;
    const start = previousSearch?.selectionStart ?? null;
    const end = previousSearch?.selectionEnd ?? null;
    const header = element("div");
    header.className = "pane-heading";
    header.append(
      element("h2", "Entries"),
      iconButton(
        "+",
        "New entry",
        () =>
          guarded(() =>
            run(() =>
              mutate({
                kind: "createEntry",
                groupId: selectedGroup || state?.groups[0]?.id || "",
                title: "New entry",
              }),
            ),
          ),
        !editable() || !state?.groups.length,
      ),
    );
    entriesPanel.replaceChildren(header);
    const searchInput = input(
      entriesPanel,
      "Search title, username, URL, tags, or group path",
      search,
      "search",
    );
    searchInput.dataset.entrySearch = "true";
    searchInput.placeholder = "Search all entries…";
    searchInput.labels?.forEach((label) => {
      label.className = "sr-only";
    });
    searchInput.addEventListener("input", () => {
      search = searchInput.value;
      renderRows();
    });
    const caption = element(
      "p",
      selectedGroup ? `Entries in ${groupPath(selectedGroup)}` : "All database entries",
    );
    caption.className = "muted";
    const body = element("div");
    body.className = "entry-list";
    body.setAttribute("role", "group");
    body.setAttribute("aria-label", "Entries");
    const empty = element("p");
    empty.className = "muted";
    empty.setAttribute("role", "status");
    entriesPanel.append(caption, body, empty);
    function renderRows(): void {
      body.replaceChildren();
      const entries = (state?.entries ?? []).filter(
        (entry) =>
          (search.trim() || !selectedGroup || entry.groupId === selectedGroup) &&
          entryMatchesSearch(entry, search, state?.groups ?? []),
      );
      for (const entry of entries) {
        const row = element("div");
        row.className = "entry-row";
        const select = button("", () => selectEntry(entry.id), !!state?.busy);
        select.className = "entry-item";
        select.setAttribute("aria-pressed", String(entry.id === selectedId));
        select.append(
          element("strong", entry.title || "(untitled)"),
          element("span", entry.username || entry.url || "No username"),
        );
        const menu = entryMenu(entry.id);
        row.append(select, menu);
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          menu.open = true;
          menu.querySelector("button")?.focus();
        });
        body.append(row);
      }
      caption.textContent = search.trim()
        ? "Search results · all groups"
        : selectedGroup
          ? groupPath(selectedGroup)
          : "All database entries";
      empty.textContent = entries.length
        ? `${entries.length} entries`
        : search.trim()
          ? "No matching entries. Try a title, username, URL, tag, or group."
          : "This group is empty. Use + to add an entry.";
    }
    renderRows();
    if (restoreSearchFocus) {
      searchInput.focus();
      searchInput.setSelectionRange(start, end);
    }
  }

  function entryMenu(id: string): HTMLDetailsElement {
    const menu = actionMenu("Entry actions");
    const summary = menu.querySelector("summary")!;
    summary.textContent = "…";
    summary.setAttribute("aria-label", "Entry actions");
    menu.querySelector(".menu-items")!.append(
      button(
        "Move / restore…",
        () =>
          guarded(() =>
            run(async () => {
              clearDetails();
              selectedId = id;
              await loadDetails(id);
              if (details) {
                showDetails(details, true);
                entryGroup?.focus();
              }
            }),
          ),
        !editable(),
      ),
      button(
        "Duplicate entry",
        () => guarded(() => run(() => mutate({ kind: "duplicateEntry", id }))),
        !editable(),
      ),
    );
    for (const permanent of [false, true]) {
      menu
        .querySelector(".menu-items")!
        .append(
          button(
            permanent ? "Permanently delete entry…" : "Delete entry…",
            () => guarded(() => run(() => mutate({ kind: "deleteEntry", id, permanent }))),
            !editable(),
          ),
        );
    }
    return menu;
  }

  function renderReadField(parent: HTMLElement, value: EntryDetails, name: string): void {
    const field = value.fields[name];
    if (!field && name !== "Password") return;
    const label = name === "UserName" ? "Username" : name;
    const box = element("section");
    box.className = "credential";
    const caption = element("h3", label);
    const text = element("p", field?.protected ? "••••••••••••" : field?.value || "Not set");
    text.className = field?.protected ? "credential-value secret" : "credential-value";
    const actions = element("div");
    actions.className = "actions";
    const copy = iconButton(
      "Copy",
      `Copy ${label}`,
      () =>
        run(async () => {
          await request({ kind: "copy", id: value.id, name });
          notify(`${label} copied. Clipboard clears after 30 seconds if unchanged.`);
        }),
      !!state?.busy,
    );
    copy.dataset.readAction = "true";
    if (field?.protected) {
      let revealed = false;
      let revealVersion = 0;
      const conceal = (): void => {
        revealed = false;
        revealVersion++;
        text.textContent = "••••••••••••";
        toggle.textContent = "Reveal";
        toggle.setAttribute("aria-label", `Reveal ${name}`);
        toggle.setAttribute("aria-pressed", "false");
      };
      const toggle = iconButton(
        "Reveal",
        `Reveal ${name}`,
        () => {
          if (revealed) {
            conceal();
            return;
          }
          run(async () => {
            const version = selectionVersion;
            const requestEpoch = epoch;
            const attempt = ++revealVersion;
            const result = await request({ kind: "reveal", id: value.id, name });
            if (
              version !== selectionVersion ||
              requestEpoch !== epoch ||
              attempt !== revealVersion ||
              document.hidden ||
              state?.locked
            )
              return;
            if (typeof result !== "string") throw new Error("Invalid revealed field response.");
            revealed = true;
            text.textContent = result;
            toggle.textContent = "Conceal";
            toggle.setAttribute("aria-label", `Conceal ${name}`);
            toggle.setAttribute("aria-pressed", "true");
            const timer = setTimeout(() => {
              conceal();
              concealTimers.delete(timer);
            }, 15_000);
            concealTimers.add(timer);
          });
        },
        !!state?.busy,
      );
      toggle.dataset.readAction = "true";
      toggle.setAttribute("aria-pressed", "false");
      toggle.title = "Reveal for 15 seconds";
      secretCleanups.add(conceal);
      actions.append(toggle);
    }
    actions.append(copy);
    if (name === "URL" && field?.value && !field.protected) {
      const open = iconButton(
        "Open",
        "Open website",
        () => run(() => request({ kind: "openUrl", id: value.id })),
        !!state?.busy,
      );
      open.dataset.readAction = "true";
      actions.append(open);
    }
    const header = element("div");
    header.className = "pane-heading";
    header.append(caption, actions);
    box.append(header, text);
    parent.append(box);
  }

  function showDetails(value: EntryDetails, edit = false): void {
    clearDetails();
    details = value;
    selectedId = value.id;
    editing = edit;
    renderEntries();
    const header = element("div");
    header.className = "pane-heading";
    const title = value.fields.Title;
    header.append(
      element("h2", title?.protected ? "Protected title" : title?.value || "(untitled)"),
    );
    if (!edit) {
      const actions = element("div");
      actions.className = "actions";
      const editButton = button("Edit", () => showDetails(value, true), !editable());
      editButton.dataset.editAction = "true";
      actions.append(editButton, entryMenu(value.id));
      header.append(actions);
      detailPanel.replaceChildren(header);
      const path = element("p", groupPath(value.groupId));
      path.className = "muted";
      detailPanel.append(path);
      for (const name of ["UserName", "Password", "URL", "Notes"])
        renderReadField(detailPanel, value, name);
      if (title?.protected) renderReadField(detailPanel, value, "Title");
      const customFields = Object.keys(value.fields).filter(
        (name) => !standardFields.includes(name),
      );
      if (customFields.length) {
        const custom = element("section");
        custom.append(element("h3", "Custom fields"));
        for (const name of customFields) renderReadField(custom, value, name);
        detailPanel.append(custom);
      }
      if (value.tags.length) detailPanel.append(element("p", `Tags · ${value.tags.join(", ")}`));
      const attachments = disclosure(
        `Attachments (${value.attachments.length})`,
        "secondary-section",
      );
      renderAttachments(value, attachments);
      const history = disclosure(`History (${value.historyCount})`, "secondary-section");
      renderHistory(value, history);
      detailPanel.append(attachments, history);
      const timestamps = element(
        "p",
        `Created ${value.created ?? "unknown"} · Modified ${value.modified ?? "unknown"}`,
      );
      timestamps.className = "muted";
      detailPanel.append(timestamps);
      return;
    }
    detailPanel.replaceChildren(header);
    detailsForm = element("form");
    const form = detailsForm;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run(async () => {
        if (await applyDraft()) {
          if (editing && details) showDetails(details);
        }
      });
    });
    draftNotice = element(
      "p",
      "Done keeps your changes. Ctrl+S / Cmd+S finishes editing and saves the database. Unfinished edits are cleared when this view is hidden or closed.",
    );
    draftNotice.className = "notice";
    draftNotice.setAttribute("role", "status");
    form.append(draftNotice);
    for (const name of new Set([...standardFields, ...Object.keys(value.fields)])) {
      const original = value.fields[name];
      const field: FieldDraft = {
        value: original?.value ?? "",
        protected: original?.protected ?? name === "Password",
        changed: false,
      };
      fields.set(name, field);
      renderField(form, name, field, original?.value === undefined && !!original?.protected);
    }
    tagsInput = input(form, "Tags (comma separated)", value.tags.join(", "));
    tagsInput.disabled = !editable();
    tagsInput.addEventListener("input", markDraft);
    entryGroup = groupSelect(form, "Group", value.groupId);
    entryGroup.disabled = !editable();
    entryGroup.addEventListener("change", markDraft);
    const customDisclosure = disclosure("Add custom field", "secondary-section");
    const custom = element("fieldset");
    custom.append(element("legend", "New custom field"));
    const customName = input(custom, "Custom field name");
    customName.maxLength = 256;
    const customProtected = checkbox(custom, "Protect new field", false);
    custom.append(
      button(
        "Add field",
        () => {
          const name = customName.value.trim();
          if (!name || fields.has(name) || fields.size >= 64) {
            notify("Use a unique nonempty field name (maximum 64 fields).", true);
            return;
          }
          const field: FieldDraft = {
            value: "",
            protected: customProtected.checked,
            changed: true,
          };
          fields.set(name, field);
          removed.delete(name);
          renderField(form, name, field, false, customDisclosure);
          customName.value = "";
          markDraft();
        },
        !editable(),
      ),
    );
    customDisclosure.append(custom);
    form.append(customDisclosure);
    const generator = disclosure("Password generator", "secondary-section");
    renderGenerator(generator);
    form.append(generator);
    const apply = element("button", "Done");
    apply.type = "submit";
    apply.disabled = !editable();
    const controls = element("div");
    controls.className = "actions";
    controls.append(
      apply,
      button("Cancel", () => {
        showDetails(value);
        notify("Edit cancelled.");
      }),
    );
    form.append(controls);
    detailPanel.append(form);
    form.querySelector("input")?.focus();
  }

  function renderField(
    form: HTMLFormElement,
    name: string,
    field: FieldDraft,
    omitted: boolean,
    before?: HTMLElement,
  ): void {
    const box = element("fieldset");
    const label = name === "UserName" ? "Username" : name;
    box.append(element("legend", label));
    const control = name === "Notes" && !field.protected ? element("textarea") : element("input");
    if (control instanceof HTMLInputElement) {
      control.type = field.protected || name === "Password" ? "password" : "text";
      control.autocomplete = "off";
    }
    control.value = field.value;
    control.maxLength = 32_768;
    control.spellcheck = false;
    control.disabled = !editable();
    control.placeholder = omitted ? "Protected value unchanged — type to replace" : "";
    labelControl(box, `${label} value`, control);
    control.addEventListener("input", () => {
      field.value = control.value;
      field.changed = true;
      if (name === "Password") field.protected = true;
      markDraft();
    });
    if (!standardFields.includes(name)) {
      const protect = checkbox(box, `Protect ${name}`, field.protected);
      protect.disabled = !editable();
      protect.addEventListener("change", () => {
        if (omitted && !field.changed) {
          protect.checked = field.protected;
          notify("Enter a replacement value before changing protection of a hidden field.", true);
          return;
        }
        field.protected = protect.checked;
        field.changed = true;
        if (control instanceof HTMLInputElement)
          control.type = field.protected ? "password" : "text";
        markDraft();
      });
      box.append(
        button(
          `Remove ${name}`,
          () => {
            fields.delete(name);
            removed.add(name);
            control.value = "";
            field.value = "";
            box.remove();
            markDraft();
          },
          !editable(),
        ),
      );
    }
    if (before) form.insertBefore(box, before);
    else form.append(box);
  }

  function renderGenerator(parent: HTMLElement): void {
    const box = element("fieldset");
    box.append(element("legend", "Password generator"));
    const length = input(box, "Generated password length", "24", "number");
    length.min = "8";
    length.max = "128";
    const lower = checkbox(box, "Lowercase", true);
    const upper = checkbox(box, "Uppercase", true);
    const digits = checkbox(box, "Digits", true);
    const symbols = checkbox(box, "Symbols", true);
    box.append(
      button(
        "Generate password",
        () =>
          run(async () => {
            if (!length.reportValidity() || !Number.isInteger(Number(length.value))) return;
            if (![lower, upper, digits, symbols].some((item) => item.checked))
              throw new Error("Select at least one character class.");
            const version = selectionVersion;
            const draft = draftVersion;
            const requestEpoch = epoch;
            const result = await request({
              kind: "generate",
              length: Number(length.value),
              lower: lower.checked,
              upper: upper.checked,
              digits: digits.checked,
              symbols: symbols.checked,
            });
            if (
              version !== selectionVersion ||
              draft !== draftVersion ||
              requestEpoch !== epoch ||
              document.hidden ||
              state?.locked
            )
              return;
            if (typeof result !== "string") throw new Error("Invalid generator response.");
            const password = fields.get("Password");
            if (!password || !detailsForm) return;
            password.value = result;
            password.changed = true;
            password.protected = true;
            const fieldsets = [...detailsForm.querySelectorAll("fieldset")];
            const passwordBox = fieldsets.find(
              (node) => node.querySelector("legend")?.textContent === "Password",
            );
            const control = passwordBox?.querySelector("input");
            if (control) {
              control.type = "password";
              control.value = result;
            }
            markDraft();
            notify("Password generated. Choose Done to keep it.");
          }),
        !editable(),
      ),
    );
    parent.append(box);
  }

  function renderAttachments(value: EntryDetails, parent: HTMLElement): void {
    const box = element("section");
    box.append(
      element("h3", "Attachments"),
      element(
        "p",
        "Attachments are never previewed or opened. Import and export use native file pickers.",
      ),
    );
    const list = element("ul");
    for (const attachment of value.attachments) {
      const row = element("li");
      row.append(
        element(
          "p",
          `${attachment.name} — ${attachment.size} bytes${attachment.protected ? " — protected" : ""}`,
        ),
      );
      const rename = input(row, `New attachment name for ${attachment.name}`, attachment.name);
      rename.maxLength = 256;
      rename.disabled = !editable();
      row.append(
        readButton("Export attachment…", () =>
          guarded(() =>
            run(() => request({ kind: "exportAttachment", id: value.id, name: attachment.name })),
          ),
        ),
        button(
          "Rename attachment",
          () =>
            guarded(() =>
              run(() =>
                mutate({
                  kind: "renameAttachment",
                  id: value.id,
                  name: attachment.name,
                  newName: rename.value,
                }),
              ),
            ),
          !editable(),
        ),
        button(
          "Remove attachment…",
          () =>
            guarded(() =>
              run(() => mutate({ kind: "removeAttachment", id: value.id, name: attachment.name })),
            ),
          !editable(),
        ),
      );
      list.append(row);
    }
    box.append(list);
    if (!value.attachments.length) box.append(element("p", "No attachments."));
    box.append(
      button(
        "Import attachment…",
        () => guarded(() => run(() => mutate({ kind: "importAttachment", id: value.id }))),
        !editable(),
      ),
    );
    parent.append(box);
  }

  function renderHistory(value: EntryDetails, parent: HTMLElement): void {
    const box = element("section");
    box.append(element("h3", `History (${value.historyCount})`));
    const list = element("ul");
    box.append(
      readButton("Load history", () =>
        guarded(() =>
          run(async () => {
            const version = selectionVersion;
            const result = await request({ kind: "history", id: value.id });
            if (version !== selectionVersion || state?.locked || document.hidden) return;
            if (
              !Array.isArray(result) ||
              !result.every(
                (item: unknown) =>
                  isRecord(item) &&
                  Number.isSafeInteger(item.index) &&
                  typeof item.index === "number" &&
                  item.index >= 0 &&
                  (item.modified === undefined || typeof item.modified === "string"),
              )
            ) {
              throw new Error("Invalid history response.");
            }
            list.replaceChildren();
            for (const item of result as Array<{ index: number; modified?: string }>) {
              const row = element(
                "li",
                `Revision ${item.index} — ${item.modified ?? "unknown time"} `,
              );
              row.append(
                button(
                  "Restore revision…",
                  () =>
                    guarded(() =>
                      run(() =>
                        mutate({ kind: "restoreHistory", id: value.id, index: item.index }),
                      ),
                    ),
                  !editable(),
                ),
              );
              list.append(row);
            }
            if (!result.length) list.append(element("li", "No saved history."));
          }),
        ),
      ),
      list,
    );
    parent.append(box);
  }

  function renderState(): void {
    if (!state) return;
    if (selectedGroup && !state.groups.some((group) => group.id === selectedGroup))
      selectedGroup = "";
    if (!state.locked && selectedId && !state.entries.some((entry) => entry.id === selectedId)) {
      const hadDraft = dirtyDraft;
      clearDetails();
      selectedId = "";
      if (hadDraft)
        notify("The selected entry no longer exists. Its unfinished edit was cleared.", true);
    }
    const becameLocked = locked.hidden && state.locked;
    heading.textContent = state.filename;
    heading.hidden = state.locked;
    status.className = state.locked ? "sr-only" : "";
    locked.hidden = !state.locked;
    unlocked.hidden = state.locked;
    app!.setAttribute("aria-busy", String(state.busy));
    status.textContent = state.busy
      ? "Database operation in progress…"
      : visibleStatus || (state.locked ? "Database locked." : "Database unlocked.");
    const notices = [
      state.readOnly
        ? "Read-only: editing and saving in place are disabled. Save as creates a separate file."
        : "",
      state.conflict
        ? "Conflict: the file changed outside this editor. Save as a separate file or revert from disk; do not overwrite the external changes."
        : "",
      state.credentialsChanged
        ? "Master password changed in memory. Save to persist the new password."
        : "",
      state.recoveryPasswordChanged
        ? "Recovered database uses a NEW master password. Save the recovered database and retain the new password."
        : "",
    ].filter(Boolean);
    flags.textContent = notices.join("\n");
    flags.hidden = !notices.length;
    if (state.error) notify(state.error, true);
    renderLocked(becameLocked);
    renderToolbar();
    renderGroups();
    renderEntries();
    updateDetailControls();
  }

  function updateDetailControls(): void {
    for (const control of detailPanel.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
    >("input, textarea, select, button")) {
      const cancel = control instanceof HTMLButtonElement && control.textContent === "Cancel";
      const read = control instanceof HTMLButtonElement && control.dataset.readAction === "true";
      control.disabled = cancel ? committing : read ? !!state?.busy : !editable() || committing;
    }
  }

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const reply = event.data;
    if (
      !isRecord(reply) ||
      reply.channel !== channel ||
      typeof reply.id !== "number" ||
      !Number.isSafeInteger(reply.id) ||
      reply.id < 0 ||
      typeof reply.ok !== "boolean" ||
      !isUiState(reply.state)
    )
      return;
    const item = reply.id === 0 ? undefined : pending.get(reply.id);
    if (reply.id !== 0 && (!item || item.epoch !== epoch)) return;
    if (reply.id !== 0) {
      pending.delete(reply.id);
      if (item) clearTimeout(item.timer);
    }
    const becameLocked = !!state && !state.locked && reply.state.locked;
    if (reply.id === 0 && reply.conceal === true) {
      const hadDraft = dirtyDraft;
      cancelPending();
      clearDetails();
      notify(
        hadDraft
          ? "Editor deactivated: unfinished edit and revealed credentials were cleared for security. Finished changes remain in the database."
          : "Editor deactivated: revealed values, generated passwords and credential controls were cleared.",
      );
    }
    if (reply.id === 0 || reply.id >= lastReply) {
      if (reply.id) lastReply = reply.id;
      state = reply.state;
      if (becameLocked) {
        const hadDraft = dirtyDraft;
        clearDetails();
        selectedId = "";
        cancelPending();
        notify(
          hadDraft
            ? "Database locked. Unfinished edit and secrets were cleared for security."
            : "Database locked; secrets cleared.",
        );
      }
      renderState();
    }
    if (item) {
      if (becameLocked) item.resolve(undefined);
      else if (!reply.ok)
        item.reject(new Error(reply.state.error || "The operation was cancelled or failed."));
      else item.resolve(reply.result);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      const hadDraft = dirtyDraft;
      cancelPending();
      clearDetails();
      notify(
        hadDraft
          ? "Editor hidden: unfinished edit and secrets were cleared for security. Re-enter changes to continue."
          : "Editor hidden: secrets and pending results were cleared.",
      );
    } else {
      run(async () => {
        await request({ kind: "refresh" });
        if (selectedId && !state?.locked && state?.entries.some((entry) => entry.id === selectedId))
          await loadDetails(selectedId);
      });
    }
  });
  function activity(): void {
    if (document.hidden || !state || state.locked || Date.now() - lastActivity < 15_000) return;
    lastActivity = Date.now();
    run(() => request({ kind: "activity" }));
  }
  document.addEventListener("pointerdown", activity);
  document.addEventListener("pointerdown", (event) => {
    for (const menu of app!.querySelectorAll<HTMLDetailsElement>(".action-menu[open]"))
      if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener("keydown", activity);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!guard.hidden) {
        guard.hidden = true;
        guardAction = undefined;
      } else if (editing && details && !committing) {
        showDetails(details);
        notify("Edit cancelled.");
      }
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || state?.locked) return;
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault();
      entriesPanel.querySelector<HTMLInputElement>("[data-entry-search]")?.focus();
    } else if (key === "s") {
      event.preventDefault();
      run(async () => {
        if (!(await applyDraft())) return;
        if (editing && details) showDetails(details);
        await mutate({ kind: event.shiftKey ? "saveAs" : "save" }, false);
      });
    } else if ((key === "z" || key === "y") && !editing) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
        return;
      event.preventDefault();
      const redo = key === "y" || event.shiftKey;
      if (editable() && (redo ? state?.canRedo : state?.canUndo))
        run(() => mutate({ kind: redo ? "redo" : "undo" }));
    }
  });
  clearDetails();
  run(() => request({ kind: "ready" }));
}

if (typeof document !== "undefined" && typeof acquireVsCodeApi === "function") start();
