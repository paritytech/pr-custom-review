module.exports = {
  testPathForConsistencyCheck: "test.ts",
  resolveSnapshotPath: function (testPath, snapshotExtension) {
    return `${testPath}${snapshotExtension}`
  },
  resolveTestPath: function (snapshotFilePath, snapshotExtension) {
    return snapshotFilePath.replace(snapshotExtension, "")
  },
}
