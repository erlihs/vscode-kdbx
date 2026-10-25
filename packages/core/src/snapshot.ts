import { Kdbx, KdbxEntry, KdbxGroup, ProtectedValue } from "@keenext/kdbxweb";
import type { KdbxBinary, KdbxBinaryWithHash } from "@keenext/kdbxweb";

function binary(value: KdbxBinary | KdbxBinaryWithHash): string {
  if (value instanceof ProtectedValue) return Buffer.from(value.getBinary()).toString("hex");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("hex");
  return binary(value.value);
}

function entry(value: KdbxEntry): object {
  return {
    uuid: value.uuid.toString(),
    fields: [...value.fields]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [
        key,
        field instanceof ProtectedValue ? { protected: field.getText() } : field,
      ]),
    binaries: [...value.binaries].map(([key, data]) => [key, binary(data)]),
    history: value.history.map(entry),
    tags: value.tags,
    created: value.times.creationTime?.toISOString(),
    modified: value.times.lastModTime?.toISOString(),
    expires: value.times.expires,
    previousParent: value.previousParentGroup?.toString(),
    qualityCheck: value.qualityCheck,
    customData: [...(value.customData ?? [])],
    autoType: value.autoType,
  };
}

function group(value: KdbxGroup): object {
  return {
    uuid: value.uuid.toString(),
    name: value.name,
    tags: value.tags,
    notes: value.notes ?? "",
    previousParent: value.previousParentGroup?.toString(),
    customData: [...(value.customData ?? [])],
    groups: value.groups.map(group),
    entries: value.entries.map(entry),
  };
}

// Synthetic-fixture oracle only. Never return this decrypted representation to a UI or disk.
export function snapshot(db: Kdbx): object {
  return {
    version: [db.versionMajor, db.versionMinor],
    cipher: db.header.dataCipherUuid?.toString(),
    compression: db.header.compression,
    kdf: db.header.kdfParameters
      ?.keys()
      .filter((key) => key !== "S")
      .map((key) => [key, db.header.kdfParameters?.get(key)]),
    groups: db.groups.map(group),
    deleted: db.deletedObjects.map((item) => [
      item.uuid?.toString(),
      item.deletionTime?.toISOString(),
    ]),
    recycleBin: db.meta.recycleBinUuid?.toString(),
    recycleBinEnabled: db.meta.recycleBinEnabled,
    customData: [...db.meta.customData],
    customIcons: [...db.meta.customIcons].map(([key, icon]) => [
      key,
      {
        data: Buffer.from(icon.data).toString("hex"),
        name: icon.name,
        modified: icon.lastModified,
      },
    ]),
    publicCustomData: db.header.publicCustomData
      ?.keys()
      .map((key) => [key, db.header.publicCustomData?.get(key)]),
  };
}
