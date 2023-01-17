module.exports = {
  testPathForConsistencyCheck: "test.ts",
  resolveSnapshotPath: (testPath, snapshotExtension) => `${testPath}${snapshotExtension}`,
  resolveTestPath: (snapshotFilePath, snapshotExtension) => snapshotFilePath.replace(snapshotExtension, ""),
};
