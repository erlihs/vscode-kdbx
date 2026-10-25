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
  let selectedId = "";
  let details: EntryDetails | undefined;
  let fields = new Map<string, FieldDraft>();
  const removed = new Set<string>();
  let dirtyDraft = false;
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
  guard.setAttribute("aria-label", "Unapplied entry changes");
  guard.hidden = true;
  const locked = element("section");
  locked.className = "panel locked";
  const unlocked = element("section");
  const toolbar = element("div");
  toolbar.className = "toolbar";
  toolbar.setAttribute("role", "group");
  toolbar.setAttribute("aria-label", "Database actions");
  const layout = element("div");
  layout.className = "layout";
  const groupsPanel = element("section");
  groupsPanel.className = "panel";
  const entriesPanel = element("section");
  entriesPanel.className = "panel";
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
    draftVersion++;
    detailsForm = undefined;
    tagsInput = undefined;
    entryGroup = undefined;
    guardAction = undefined;
    guard.hidden = true;
    detailPanel.replaceChildren(
      element("h2", "Entry details"),
      element("p", "Select an entry to view its fields."),
    );
  }

  function button(text: string, action: () => void, disabled = false): HTMLButtonElement {
    const node = element("button", text);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
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
      draftNotice.textContent =
        "Unapplied changes — Apply changes updates the database in memory. Save then writes it to disk. This draft is not saved or recovered if the view closes.";
  }

  async function applyDraft(): Promise<boolean> {
    if (!details || !dirtyDraft) return true;
    if (!editable() || !detailsForm?.reportValidity() || !tagsInput || !entryGroup) return false;
    const version = draftVersion;
    const selected = selectedId;
    const result = await request({
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
    if (version !== draftVersion || selected !== selectedId) {
      notify("Changes made while applying are still unapplied. Apply again before leaving.", true);
      return false;
    }
    dirtyDraft = false;
    removed.clear();
    notify("Entry changes applied in memory. Use Save to write to disk.");
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
      element("h2", "Unapplied entry changes"),
      element(
        "p",
        "Apply or discard this entry draft before continuing. Applying does not save the file.",
      ),
    );
    guard.append(
      button("Apply and continue", () =>
        run(async () => {
          const next = guardAction;
          if (await applyDraft()) {
            guard.hidden = true;
            guardAction = undefined;
            next?.();
          }
        }),
      ),
      button("Discard draft and continue", () => {
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
      run(() => loadDetails(id));
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
      await loadDetails(resultId);
    } else if (refreshDetails && id && id === selectedId) {
      if (isEntryDetails(result) && result.id === id) showDetails(result);
      else if (state?.entries.some((entry) => entry.id === id)) await loadDetails(id);
      else {
        clearDetails();
        selectedId = "";
      }
    }
    notify("Operation completed. Save writes database changes to disk.");
  }

  function renderLocked(): void {
    locked.replaceChildren(
      element("h2", "Database locked"),
      element(
        "p",
        "Unlock locally with the database master password. Credentials are not stored in the webview.",
      ),
    );
    const form = element("form");
    const password = input(form, "Master password", "", "password");
    password.maxLength = 16_384;
    password.autocomplete = "current-password";
    password.disabled = state?.busy ?? false;
    const submit = element("button", state?.busy ? "Unlocking…" : "Unlock");
    submit.type = "submit";
    submit.disabled = state?.busy ?? false;
    form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = password.value;
      password.value = "";
      run(() => request({ kind: "unlock", password: value }));
    });
    form.append(
      button("Cancel unlock", () => run(() => request({ kind: "cancelUnlock" })), !state?.busy),
    );
    locked.append(
      form,
      button(
        "New database…",
        () => run(() => request({ kind: "createDatabase" })),
        state?.busy ?? false,
      ),
    );
  }

  function renderToolbar(): void {
    toolbar.replaceChildren();
    const actions: Array<[string, EditorAction, boolean]> = [
      ["Save", { kind: "save" }, !editable() || !!state?.conflict],
      ["Save as…", { kind: "saveAs" }, !!state?.busy],
      ["Revert from disk…", { kind: "revert" }, !!state?.busy],
      ["Lock", { kind: "lock" }, !!state?.busy],
      ["Undo", { kind: "undo" }, !editable() || !state?.canUndo],
      ["Redo", { kind: "redo" }, !editable() || !state?.canRedo],
    ];
    for (const [label, action, disabled] of actions) {
      toolbar.append(
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
    toolbar.append(
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
    groupsPanel.replaceChildren(element("h2", "Groups"));
    groupsPanel.append(
      button("All entries", () =>
        guarded(() => {
          selectedGroup = "";
          renderGroups();
          renderEntries();
        }),
      ),
    );
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
      control.setAttribute("aria-pressed", String(selectedGroup === group.id));
      row.append(control);
      const children = element("ul");
      for (const child of state?.groups ?? [])
        if (child.parentId === group.id) add(child, children);
      if (children.children.length) row.append(children);
      parent.append(row);
    }
    const groups = state?.groups ?? [];
    for (const group of groups)
      if (group.parentId === null || !groups.some((item) => item.id === group.parentId))
        add(group, list);
    for (const group of groups) if (!visited.has(group.id)) add(group, list);
    groupsPanel.append(list);
    if (!groups.length) groupsPanel.append(element("p", "No groups available."));
    const form = element("form");
    const name = input(form, "Group name");
    name.maxLength = 4096;
    name.disabled = !editable();
    const destination = groupSelect(
      form,
      "Parent / move destination",
      selectedGroup || groups[0]?.id || "",
    );
    destination.disabled = !editable();
    const controls = element("div");
    controls.className = "actions";
    const selected = groups.find((group) => group.id === selectedGroup);
    const groupAction = (action: EditorAction): void =>
      guarded(() => run(() => mutate(action, false)));
    controls.append(
      button(
        "Create group",
        () => {
          if (!name.value.trim()) {
            notify("Enter a group name.", true);
            return;
          }
          groupAction({ kind: "createGroup", parentId: destination.value, name: name.value });
        },
        !editable() || !groups.length,
      ),
      button(
        "Rename group",
        () => {
          if (!name.value.trim()) {
            notify("Enter a group name.", true);
            return;
          }
          groupAction({ kind: "renameGroup", id: selectedGroup, name: name.value });
        },
        !editable() || !selected,
      ),
      button(
        "Move / restore group",
        () => groupAction({ kind: "moveGroup", id: selectedGroup, parentId: destination.value }),
        !editable() || !selected || selected.parentId === null,
      ),
      button(
        "Delete group…",
        () => groupAction({ kind: "deleteGroup", id: selectedGroup, permanent: false }),
        !editable() || !selected || selected.parentId === null,
      ),
      button(
        "Permanently delete group…",
        () => groupAction({ kind: "deleteGroup", id: selectedGroup, permanent: true }),
        !editable() || !selected || selected.parentId === null,
      ),
    );
    form.addEventListener("submit", (event) => event.preventDefault());
    form.append(
      controls,
      element(
        "p",
        "Restore recycled groups by moving them to a regular parent. Deletion is confirmed by VS Code.",
      ),
    );
    groupsPanel.append(form);
  }

  function renderEntries(): void {
    entriesPanel.replaceChildren(element("h2", "Entries"));
    const searchInput = input(
      entriesPanel,
      "Search title, username, URL, tags, or group path",
      search,
      "search",
    );
    searchInput.addEventListener("input", () => {
      search = searchInput.value;
      renderRows();
    });
    const actions = element("div");
    actions.className = "actions";
    const title = input(entriesPanel, "New entry title");
    title.maxLength = 4096;
    title.disabled = !editable();
    actions.append(
      button(
        "Create entry",
        () =>
          guarded(() =>
            run(() =>
              mutate({
                kind: "createEntry",
                groupId: selectedGroup || state?.groups[0]?.id || "",
                title: title.value || "New entry",
              }),
            ),
          ),
        !editable() || !state?.groups.length,
      ),
    );
    entriesPanel.append(actions);
    const table = element("table");
    const caption = element(
      "caption",
      selectedGroup ? `Entries in ${groupPath(selectedGroup)}` : "All database entries",
    );
    const head = element("thead");
    const header = element("tr");
    for (const text of ["Title", "Username", "URL"]) {
      const th = element("th", text);
      th.scope = "col";
      header.append(th);
    }
    head.append(header);
    const body = element("tbody");
    table.append(caption, head, body);
    const empty = element("p");
    entriesPanel.append(table, empty);
    function renderRows(): void {
      body.replaceChildren();
      const entries = (state?.entries ?? []).filter(
        (entry) =>
          (!selectedGroup || entry.groupId === selectedGroup) &&
          entryMatchesSearch(entry, search, state?.groups ?? []),
      );
      for (const entry of entries) {
        const row = element("tr");
        row.setAttribute("aria-selected", String(entry.id === selectedId));
        const titleCell = element("td");
        titleCell.append(
          button(entry.title || "(untitled)", () => selectEntry(entry.id), !!state?.busy),
        );
        row.append(titleCell, element("td", entry.username), element("td", entry.url));
        body.append(row);
      }
      empty.textContent = entries.length
        ? `${entries.length} entries`
        : "No entries match this group and search.";
    }
    renderRows();
  }

  function showDetails(value: EntryDetails): void {
    clearDetails();
    details = value;
    selectedId = value.id;
    detailPanel.replaceChildren(element("h2", "Entry details"));
    detailsForm = element("form");
    const form = detailsForm;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run(applyDraft);
    });
    draftNotice = element(
      "p",
      "Fields are not saved until you Apply changes, then Save the database. Unapplied drafts exist only in this view and cannot be recovered after closing it.",
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
    entryGroup = groupSelect(form, "Entry group / restore destination", value.groupId);
    entryGroup.disabled = !editable();
    entryGroup.addEventListener("change", markDraft);
    form.append(
      element(
        "p",
        "Move or restore this entry by choosing its destination group and applying changes.",
      ),
    );
    const custom = element("fieldset");
    custom.append(element("legend", "Add a named custom field"));
    const customName = input(custom, "Custom field name");
    customName.maxLength = 256;
    const customProtected = checkbox(custom, "Protect new field", false);
    custom.append(
      button(
        "Add field to draft",
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
          renderField(form, name, field, false, custom);
          customName.value = "";
          markDraft();
        },
        !editable(),
      ),
    );
    form.append(custom);
    const apply = element("button", "Apply changes");
    apply.type = "submit";
    apply.disabled = !editable();
    const controls = element("div");
    controls.className = "actions";
    controls.append(
      apply,
      button("Discard unapplied draft", () => {
        showDetails(value);
        notify("Unapplied draft discarded.");
      }),
    );
    form.append(controls);
    detailPanel.append(form);
    const operations = element("div");
    operations.className = "actions";
    operations.append(
      button(
        "Duplicate entry",
        () => guarded(() => run(() => mutate({ kind: "duplicateEntry", id: value.id }))),
        !editable(),
      ),
      button(
        "Delete entry…",
        () =>
          guarded(() => run(() => mutate({ kind: "deleteEntry", id: value.id, permanent: false }))),
        !editable(),
      ),
      button(
        "Permanently delete entry…",
        () =>
          guarded(() => run(() => mutate({ kind: "deleteEntry", id: value.id, permanent: true }))),
        !editable(),
      ),
    );
    detailPanel.append(
      operations,
      element(
        "p",
        `Created: ${value.created ?? "unknown"} · Modified: ${value.modified ?? "unknown"}`,
      ),
    );
    renderGenerator();
    renderAttachments(value);
    renderHistory(value);
  }

  function renderField(
    form: HTMLFormElement,
    name: string,
    field: FieldDraft,
    omitted: boolean,
    before?: HTMLElement,
  ): void {
    const box = element("fieldset");
    box.append(element("legend", name));
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
    labelControl(box, `${name} value`, control);
    control.addEventListener("input", () => {
      field.value = control.value;
      field.changed = true;
      markDraft();
    });
    const protect = checkbox(box, `Protect ${name}`, field.protected);
    protect.disabled = !editable();
    protect.addEventListener("change", () => {
      if (omitted && !field.changed) {
        protect.checked = field.protected;
        notify(
          "To change protection of a hidden field, explicitly enter its replacement value first. The existing secret is never replaced with a blank.",
          true,
        );
        return;
      }
      field.protected = protect.checked;
      field.changed = true;
      if (control instanceof HTMLInputElement)
        control.type = field.protected || name === "Password" ? "password" : "text";
      markDraft();
    });
    const actions = element("div");
    actions.className = "actions";
    const revealed = element("input");
    revealed.type = "text";
    revealed.readOnly = true;
    revealed.className = "secret";
    revealed.autocomplete = "off";
    revealed.spellcheck = false;
    const revealLabel = element("label", `${name} revealed value (conceals after 15 seconds)`);
    revealed.id = `control-${++controlId}`;
    revealLabel.htmlFor = revealed.id;
    revealLabel.hidden = true;
    revealed.hidden = true;
    const conceal = (): void => {
      revealed.value = "";
      revealed.hidden = true;
      revealLabel.hidden = true;
    };
    secretCleanups.add(conceal);
    actions.append(
      button(
        `Reveal saved ${name}`,
        () =>
          run(async () => {
            const id = selectedId;
            const version = selectionVersion;
            const requestEpoch = epoch;
            const result = await request({ kind: "reveal", id, name });
            if (
              id !== selectedId ||
              version !== selectionVersion ||
              requestEpoch !== epoch ||
              document.hidden ||
              state?.locked
            )
              return;
            if (typeof result !== "string") throw new Error("Invalid revealed field response.");
            conceal();
            revealed.value = result;
            revealed.hidden = false;
            revealLabel.hidden = false;
            const timer = setTimeout(() => {
              conceal();
              concealTimers.delete(timer);
            }, 15_000);
            concealTimers.add(timer);
          }),
        !!state?.busy,
      ),
      button(`Conceal ${name}`, conceal),
      button(
        `Copy saved ${name}`,
        () =>
          run(async () => {
            await request({ kind: "copy", id: selectedId, name });
            notify("Copy requested through VS Code. Unapplied values are not copied.");
          }),
        !!state?.busy,
      ),
    );
    if (!standardFields.includes(name))
      actions.append(
        button(
          `Remove ${name} from draft`,
          () => {
            fields.delete(name);
            removed.add(name);
            control.value = "";
            field.value = "";
            conceal();
            box.remove();
            markDraft();
          },
          !editable(),
        ),
      );
    box.append(actions, revealLabel, revealed);
    if (before) form.insertBefore(box, before);
    else form.append(box);
  }

  function renderGenerator(): void {
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
        "Generate into password draft",
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
            const protect = passwordBox?.querySelector<HTMLInputElement>("input[type=checkbox]");
            if (protect) protect.checked = true;
            markDraft();
            notify(
              "Generated password is masked in the unapplied draft. Apply changes, then Save.",
            );
          }),
        !editable(),
      ),
    );
    detailPanel.append(box);
  }

  function renderAttachments(value: EntryDetails): void {
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
        button(
          "Export attachment…",
          () =>
            guarded(() =>
              run(() => request({ kind: "exportAttachment", id: value.id, name: attachment.name })),
            ),
          !!state?.busy,
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
    detailPanel.append(box);
  }

  function renderHistory(value: EntryDetails): void {
    const box = element("section");
    box.append(element("h3", `History (${value.historyCount})`));
    const list = element("ul");
    box.append(
      button(
        "Load history",
        () =>
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
        !!state?.busy,
      ),
      list,
    );
    detailPanel.append(box);
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
        notify("The selected entry no longer exists. Its unapplied draft was cleared.", true);
    }
    heading.textContent = state.filename;
    locked.hidden = !state.locked;
    unlocked.hidden = state.locked;
    app!.setAttribute("aria-busy", String(state.busy));
    status.textContent = state.busy
      ? "Database operation in progress…"
      : visibleStatus || (state.locked ? "Database locked." : "Database unlocked.");
    const notices = [
      state.dirty ? "Unsaved database changes." : "No unsaved database changes.",
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
    if (state.error) notify(state.error, true);
    renderLocked();
    renderToolbar();
    renderGroups();
    renderEntries();
    if (detailsForm) {
      for (const control of detailsForm.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
      >("input, textarea, select, button")) {
        // Reveal/copy controls remain available in read-only databases.
        const readAction =
          control instanceof HTMLButtonElement &&
          /^(Reveal |Conceal |Copy saved |Discard )/.test(control.textContent ?? "");
        control.disabled = readAction ? state.busy : !editable();
      }
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
          ? "Editor deactivated: unapplied draft, revealed values, generated passwords and credential controls were erased for security. Only applied model changes can be saved or recovered."
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
            ? "Database locked. Unapplied draft and secrets were cleared for security."
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
          ? "Editor hidden: unapplied draft and secrets were erased for security. Re-enter changes before applying."
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
  document.addEventListener("keydown", activity);
  clearDetails();
  run(() => request({ kind: "ready" }));
}

if (typeof document !== "undefined" && typeof acquireVsCodeApi === "function") start();
