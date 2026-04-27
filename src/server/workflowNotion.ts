import * as notion from './notion.js';

export type WorkflowNestedDatabaseResolution = {
  childDatabases: Array<{id: string; title: string}>;
  discoverySource: notion.NestedDatabaseLookupSource;
  nestedId: string;
  nestedIds: string[];
};

export async function resolveWorkflowManagerNestedDatabase(
  pageId: string,
  targetTitle: string = '作業内容',
): Promise<WorkflowNestedDatabaseResolution> {
  const nestedDatabaseResult = await notion.findNestedDatabasesWithSource(pageId, targetTitle);
  const nestedIds = nestedDatabaseResult.ids;

  if (nestedIds.length > 0) {
    return {
      childDatabases: [],
      discoverySource: nestedDatabaseResult.source,
      nestedId: nestedIds[0],
      nestedIds,
    };
  }

  const childDatabases = await notion.listChildDatabases(pageId, true);
  const titles = childDatabases.map((db) => db.title).filter(Boolean);
  const suffix = titles.length
    ? ` Detected child databases: ${titles.join(', ')}`
    : ' No child databases were detected under the selected page.';

  throw new Error(`No nested '${targetTitle}' database found in the selected calendar page.${suffix}`);
}
