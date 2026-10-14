// Rollup de status: Task -> Feature -> Epic, usando sub-issues + GitHub Projects v2 (Project pessoal).
const env = process.env;
const TOKEN = env.PROJECT_TOKEN;
const OWNER = env.PROJECT_OWNER;
const NUMBER = Number(env.PROJECT_NUMBER);
const DRY = env.DRY_RUN === 'true';
const S = {
  todo: env.STATUS_TODO || 'Todo',
  prog: env.STATUS_IN_PROGRESS || 'In Progress',
  done: env.STATUS_DONE || 'Done',
  ignore: env.STATUS_IGNORE || '',
};
if (!TOKEN || !OWNER || !NUMBER) throw new Error('Faltam PROJECT_TOKEN / PROJECT_OWNER / PROJECT_NUMBER');

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'GraphQL-Features': 'sub_issues',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const QUERY = `
query($login:String!, $number:Int!, $cursor:String) {
  user(login:$login) {
    projectV2(number:$number) {
      id
      field(name:"Status") {
        ... on ProjectV2SingleSelectField { id options { id name } }
      }
      items(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          status: fieldValueByName(name:"Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            ... on Issue {
              id
              subIssues(first:100) { nodes { id } }
            }
          }
        }
      }
    }
  }
}`;

async function loadProject() {
  let cursor = null, project = null;
  const items = [];
  do {
    const d = await gql(QUERY, { login: OWNER, number: NUMBER, cursor });
    const p = d.user?.projectV2;
    if (!p) throw new Error(`Project ${NUMBER} não encontrado para o usuário ${OWNER}`);
    project ??= { id: p.id, field: p.field };
    items.push(...p.items.nodes);
    cursor = p.items.pageInfo.hasNextPage ? p.items.pageInfo.endCursor : null;
  } while (cursor);
  return { project, items };
}

const MUTATION = `
mutation($project:ID!, $item:ID!, $field:ID!, $option:String!) {
  updateProjectV2ItemFieldValue(input:{
    projectId:$project, itemId:$item, fieldId:$field,
    value:{ singleSelectOptionId:$option }
  }) { projectV2Item { id } }
}`;

async function main() {
  const { project, items } = await loadProject();
  const optionId = Object.fromEntries(project.field.options.map(o => [o.name, o.id]));
  for (const n of [S.todo, S.prog, S.done]) {
    if (!optionId[n]) throw new Error(`Opção de Status "${n}" não existe. Opções: ${Object.keys(optionId)}`);
  }

  // nós = issues que estão no Project
  const nodes = new Map();
  for (const it of items) {
    const c = it.content;
    if (!c?.id) continue; // draft, PR etc.
    nodes.set(c.id, {
      itemId: it.id,
      status: it.status?.name ?? S.todo,
      children: (c.subIssues?.nodes ?? []).map(k => k.id),
    });
  }

  const memo = new Map();
  const visiting = new Set();
  let changes = 0;

  async function resolve(id) {
    if (memo.has(id)) return memo.get(id);
    const n = nodes.get(id);
    if (visiting.has(id)) return n.status; // proteção contra ciclo
    visiting.add(id);

    const kids = n.children.filter(k => nodes.has(k));
    if (kids.length) {
      let ks = [];
      for (const k of kids) ks.push(await resolve(k));
      if (S.ignore) ks = ks.filter(s => s !== S.ignore);

      if (ks.length) {
        const derived = ks.every(s => s === S.done) ? S.done
                      : ks.every(s => s === S.todo) ? S.todo
                      : S.prog;
        const managed = [S.todo, S.prog, S.done].includes(n.status); // não mexe em Blocked etc.
        const skipRegress = derived === S.todo && n.status !== S.done; // só volta pra Todo se estava Done
        if (managed && derived !== n.status && !skipRegress) {
          console.log(`${id}: ${n.status} -> ${derived}${DRY ? ' (dry-run)' : ''}`);
          if (!DRY) {
            await gql(MUTATION, {
              project: project.id, item: n.itemId,
              field: project.field.id, option: optionId[derived],
            });
          }
          n.status = derived;
          changes++;
        }
      }
    }
    visiting.delete(id);
    memo.set(id, n.status);
    return n.status;
  }

  for (const id of nodes.keys()) await resolve(id);
  console.log(`Concluído: ${changes} alteração(ões).`);
}

main().catch(e => { console.error(e); process.exit(1); });
