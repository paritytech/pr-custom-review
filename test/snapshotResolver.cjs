module.exports = {
  testPathForConsistencyCheck: "test.ts",
  resolveSnapshotPath: (testPath, snapshotExtension) => {
    return `${testPath}${snapshotExtension}`
  },
  resolveTestPath: (snapshotFilePath, snapshotExtension) => {
    return snapshotFilePath.replace(snapshotExtension, "")
  },
}
