# Rollup automático de status (Epic > Feature > Task) no GitHub Projects

Automação que mantém o campo **Status** dos itens pai sincronizado com o status dos filhos, usando **sub-issues** e **GitHub Projects v2**.

- Task muda para *In progress* → a Feature vira *In progress* → o Epic vira *In progress*.
- Todas as filhas em *Done* → o pai vira *Done* (e sobe nível por nível).

Este documento cobre **dois cenários**, com arquivos separados:

| Cenário | Project | Arquivos | Situação |
|---|---|---|---|
| **A. Projeto pessoal** | Project v2 de um usuário | `status-rollup.yml` + `status-rollup.mjs` | Implementado e validado |
| **B. Organização** | Project v2 de uma organização | `status-rollup_org.yml` + `status-rollup_org.mjs` | Pronto como artefato, **ainda não validado** em uma org |

> Os dois cenários usam **cron** como gatilho principal e a mesma lógica de rollup. O que muda é a forma de localizar o Project e de autenticar.

---

## 1. Conceitos comuns

### 1.1 Como funciona

Um workflow do GitHub Actions roda um script Node a cada ~5 minutos (e também quando uma issue é fechada/reaberta ou manualmente). O script:

1. Lê todos os itens do Project e a hierarquia de sub-issues.
2. Resolve de baixo para cima (Task → Feature → Epic).
3. Calcula o status esperado de cada pai a partir dos **filhos diretos**.
4. Atualiza o campo Status do pai **somente se o valor mudou**.

O script não sabe se um item é Task, Feature ou Epic. Quem **tem filhos** é pai (status calculado); quem **não tem** é folha (status definido manualmente). Por isso funciona com qualquer número de níveis, e os nomes Epic/Feature/Task são apenas convenção.

Uma Feature sem tasks é folha (você controla o status). Ao adicionar a primeira task, ela passa a ser calculada.

### 1.2 Regras de cálculo

| Status dos filhos | Status do pai |
|---|---|
| Todos *Done* (e fechados) | *Done* |
| Todos *Todo* | *Todo* |
| Qualquer outra combinação (algum *In progress*, ou mistura) | *In progress* |

O status do pai depende só do estado **atual** dos filhos, sem histórico: se um filho continua em *In progress*, o pai se mantém em *In progress*, e só volta para *Todo* quando o último filho voltar.

Detalhes:

- Uma **folha** só conta como concluída se estiver em *Done* **e** com a issue fechada. Folha em *Done* mas aberta mantém o pai em *In progress* (o script não fecha a folha). Um filho que também é pai e foi calculado como *Done* conta como concluído na mesma execução, pois o auto-close o fechará.
- O status de um pai com filhos no Project não deve ser alterado manualmente: a edição é desfeita na próxima execução (em até ~5 minutos). O Project não permite bloquear o campo, então a consistência é garantida por reconciliação.

- Pais com status fora do trio configurado (ex.: *Blocked*) **não são alterados**.
- Filhos no status de `STATUS_IGNORE` (ex.: *Canceled*) são ignorados no cálculo.
- Filhos que não estão no Project são ignorados.
- Itens sem Status são tratados como *Todo*.

**Reabertura de issues:** depois do cálculo, toda issue **fechada** cujo status final seja *Todo* ou *In progress* (folha movida manualmente ou pai que saiu de *Done*) é reaberta. Detalhes:

- Vale também para issues fechadas como "not planned".
- Só reabre se a issue foi fechada há mais de `REOPEN_GRACE_MINUTES` (padrão 2). Isso evita reabrir uma issue recém-fechada antes de o workflow nativo "Item closed" marcá-la como *Done*.
- Status fora do trio (*Blocked*, `STATUS_IGNORE`) nunca reabre.
- Pode ser desligado com `REOPEN_CLOSED: 'false'`.
- Respeita o `dry_run`.

### 1.3 Por que cron e não evento em tempo real

Segundo a lista oficial de eventos do GitHub Actions, mudanças de campo em Projects v2 **não disparam workflows** (o evento `projects_v2_item` existe como webhook, mas não como gatilho de workflow). Por isso a reconciliação por cron é o gatilho principal, com atraso de até ~5 minutos. O GitHub pode atrasar execuções agendadas em horários de pico. Veja [Tempo real (opcional)](#7-tempo-real-opcional).

### 1.4 Pré-requisitos comuns

- Um Project v2 com o campo **Status** (single select).
- Issues ligadas por **sub-issues** nativas (Epic → Feature → Task) e adicionadas ao Project.
- Os arquivos na **branch padrão** do repositório (workflows agendados só rodam nela).
- Os nomes das opções de Status conhecidos **exatamente** (maiúsculas, espaços e acentos contam).
- Workflows nativos do Project (⋯ → Workflows): mantenha **Item closed** (→ Done), **Auto-close issue** (Done → fecha) e **Item added to project** ativos, e **Item reopened desativado**. Se ele estiver ativo, ao reabrir uma issue o Project sobrescreve o status com um valor fixo, o que pode desfazer o status escolhido numa folha.

### 1.5 Estrutura de arquivos

```
seu-repo/
├── .github/
│   ├── workflows/
│   │   ├── status-rollup.yml          # cenário A (pessoal)
│   │   └── status-rollup_org.yml      # cenário B (organização)
│   └── scripts/
│       ├── status-rollup.mjs          # cenário A
│       └── status-rollup_org.mjs      # cenário B
└── docs/
    └── status-rollup.md               # este documento
```

> **Importante:** não deixe os dois workflows ativos apontando para o **mesmo** Project: ambos rodariam no cron e fariam as mesmas escritas. Use o cenário A **ou** o B por Project. Se for adotar só um, remova o outro par de arquivos.

---

## 2. Comparação rápida

| Aspecto | A. Pessoal | B. Organização |
|---|---|---|
| Busca do Project na API | `user(login:)` | `repositoryOwner(login:)` (serve para org e usuário) |
| Autenticação | PAT classic (`PROJECT_TOKEN`) | GitHub App (recomendado) ou PAT |
| Log de alterações | ID interno da issue (`I_kwDO...`) | `repo#número título` |
| Valida `STATUS_IGNORE` | Não | Sim |
| Mensagem de erro de Project | Genérica | Aponta owner/número/permissões |
| Status de validação | Testado (ver seção 3.6) | Não testado em org |

---

## 3. Cenário A: Projeto pessoal (implementado)

### 3.1 O que foi feito

- Workflow `status-rollup.yml` com gatilhos: `schedule` (a cada 5 min), `workflow_dispatch` (com opção `dry_run`) e `issues` (closed/reopened).
- Script `status-rollup.mjs` em Node 20, sem dependências, usando a API GraphQL do GitHub.
- Autenticação por **PAT classic** guardado em secret.
- `concurrency` para impedir execuções sobrepostas.

### 3.2 Autenticação (PAT classic)

O `GITHUB_TOKEN` padrão do Actions **não acessa Projects v2**. Para Projects pessoais, pelo que sei, GitHub Apps também não têm acesso, então o caminho é um PAT.

1. Em **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)**, gere um token com os escopos **`project`** e **`repo`**.
2. No repositório: **Settings → Secrets and variables → Actions → New repository secret**, nome **`PROJECT_TOKEN`**, valor o token.

### 3.3 Configuração do workflow

No bloco `env` de `status-rollup.yml`:

```yaml
PROJECT_OWNER: ${{ github.repository_owner }}   # seu usuário
PROJECT_NUMBER: '7'                             # número do Project (URL: /users/<voce>/projects/<N>)
STATUS_TODO: 'Todo'
STATUS_IN_PROGRESS: 'In progress'               # atenção ao "p" minúsculo
STATUS_DONE: 'Done'
STATUS_IGNORE: ''                               # ex.: 'Canceled'
REOPEN_CLOSED: 'true'                           # reabre issues fechadas que voltaram para Todo / In progress
REOPEN_GRACE_MINUTES: '2'                       # só reabre se fechada há mais que isso
```

- Se o Project é seu mas o repositório está em outra conta, defina `PROJECT_OWNER` com o seu usuário.
- Para conferir os nomes: abra o Project → menu **⋯** → **Settings** → campo **Status**. Se algum nome estiver errado, o script falha listando as opções existentes.
- Faça commit dos arquivos na `main`.

### 3.4 Como rodar manualmente

1. Aba **Actions** → **Status rollup** na barra lateral.
2. **Run workflow** → branch `main` → marque **dry_run** (para teste) → **Run workflow**.
3. Abra a execução → job **rollup** → passo **Run node ...** para ver o log.

O **dry-run** executa tudo, exceto a escrita: apenas imprime no log o que mudaria. Só existe nas execuções manuais; o cron e o gatilho de issue sempre rodam em modo real.

### 3.5 Roteiro de teste

Cenário: uma issue mãe com duas sub-issues, todas no Project em *Todo*.

| Ação | Resultado esperado |
|---|---|
| Rodar com `dry_run` | `Concluído: 0 alteração(ões).` |
| Subtask 1 → *In progress* | Mãe: `Todo -> In progress` |
| Subtasks 1 e 2 → *Done* | Mãe: `In progress -> Done` |
| Mãe em *Done*, subtask volta para *In progress* | Mãe: `Done -> In progress` (reabertura) |
| Epic com a Feature como sub-issue | Epic acompanha a Feature na mesma execução (3 níveis) |
| Task *Done* (issue fechada) volta para *In progress* | Task: issue reaberta (`reabrir issue (CLOSED -> OPEN)`) |
| Mãe *Done* (fechada) e subtask volta para *In progress* | Mãe: `Done -> In progress` e issue da mãe reaberta |
| Nova task adicionada a uma Feature *Done* | Feature sai de *Done* e a issue é reaberta; o Epic acompanha |
| Fechar uma issue manualmente | Não é reaberta (carência) e o "Item closed" marca *Done* |
| Issue fechada com status *Blocked* ou `STATUS_IGNORE` | Não é reaberta |
| Pai em *In progress* (na mão), todas as filhas em *Todo* | Pai volta para *Todo* |
| Todas as filhas de *In progress* para *Todo*, uma de cada vez | Pai fica em *In progress* até a última voltar; depois *Todo* |
| Uma filha em *In progress*, as outras em *Todo* | Pai em *In progress* |
| Filha em *Done* mas issue aberta, outras em *Done* | Pai em *In progress* |
| Todas as filhas fechadas e em *Done* | Pai *Done* (fecha pelo auto-close) |
| Pai movido para *Done* na mão com filhas abertas | Revertido para *In progress*; issue reaberta |
| Pai em *Blocked* | Não é alterado |

### 3.6 Resultados da validação

- Dry-run inicial: job verde, `0 alteração(ões)`, o que validou token, owner, número do Project e nomes de Status.
- Subtask em *In progress*: log `Todo -> In progress (dry-run)` para a mãe.
- Cron em modo real: ao mover as subtasks, a mãe foi atualizada automaticamente sem intervenção.
- Reabertura: log `Done -> In progress (dry-run)` e comportamento confirmado.
- Três níveis (Epic > Feature > Task): funcionou, com o rollup subindo numa única execução.
- Reabertura de issues fechadas (v3): testada no GitHub no cenário A e funcionou conforme esperado.
- Status do pai só pelas folhas (v4): testado no GitHub no cenário A e funcionou conforme esperado.

**Ajuste que foi necessário:** o nome da opção no board era `In progress` (p minúsculo) e o YAML estava com `In Progress`. Só o YAML precisou mudar, pois os nomes vêm de variáveis de ambiente.

### 3.7 Limitações do cenário pessoal

- Atraso de até ~5 minutos entre a mudança e o rollup.
- O PAT fica atrelado à sua conta: as alterações aparecem como feitas por você.
- Sem gatilho em tempo real (Projects pessoais não têm webhook de organização).

---

## 4. Cenário B: Organização (artefato)

> **Situação:** arquivos prontos, sintaxe do script validada, mas **não testados contra uma organização real**. Rode primeiro em dry-run.

### 4.1 O que muda em relação ao cenário A

- **Script** `status-rollup_org.mjs`:
  - Busca o Project com `repositoryOwner` + `ProjectV2Owner`, aceitando organização ou usuário.
  - O log mostra `repo#número título` em vez do ID interno.
  - Valida também `STATUS_IGNORE`.
  - Mensagens de erro mais específicas (owner, número, permissões, campo Status ausente).
- **Workflow** `status-rollup_org.yml`:
  - Nome `Status rollup (org)` e `concurrency` próprio (`status-rollup-org`).
  - Passo opcional que gera token de um **GitHub App** quando a variável `APP_ID` existe; caso contrário usa o secret `PROJECT_TOKEN` (PAT).
  - `permissions: contents: read`.

### 4.2 Preparar o Project da organização

1. Anote o **número** na URL: `https://github.com/orgs/<ORG>/projects/<N>`.
2. Em **⋯ → Settings → Status**, anote os nomes exatos das opções.
3. Garanta que as issues (de um ou vários repositórios) estejam no Project e ligadas como sub-issues.

### 4.3 Autenticação

#### Opção 1: GitHub App (recomendada)

Vantagens: não depende de uma pessoa, permissões mínimas, alterações aparecem como bot.

**Criar o App**

1. Na organização: **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Preencha:
   - **GitHub App name**: ex. `status-rollup-bot` (único).
   - **Homepage URL**: qualquer URL válida.
   - **Webhook**: desmarque **Active**.
3. **Permissions**:
   - **Organization permissions → Projects**: `Read and write`
   - **Repository permissions → Issues**: `Read and write` (necessário para reabrir issues)
   - (Metadata: Read-only é adicionado automaticamente.)
4. **Where can this GitHub App be installed?**: `Only on this account`.
5. **Create GitHub App**.

**Chave e ID**

1. Na página do App, anote o **App ID**. Versões mais novas podem exibir também um *Client ID*.
2. Em **Private keys → Generate a private key**: baixa um `.pem`. Guarde com segurança.

**Instalar**

1. **Install App** → escolha a organização → **Install**.
2. Em **Repository access**, selecione todos os repositórios cujas issues estão no Project (inclua o repositório do workflow).

**Credenciais no repositório do workflow** (**Settings → Secrets and variables → Actions**):

| Tipo | Nome | Valor |
|---|---|---|
| Variable | `APP_ID` | o App ID |
| Secret | `APP_PRIVATE_KEY` | conteúdo completo do `.pem`, com as linhas `BEGIN`/`END` |

Para reutilizar em vários repositórios, crie os dois no nível da **organização**.

O passo `actions/create-github-app-token@v2` do workflow só roda se `APP_ID` estiver definido. Se a versão da action exigir `client-id` em vez de `app-id`, ajuste o parâmetro conforme a documentação da action.

#### Opção 2: PAT

- **Classic**: escopos `project` e `repo`. Se a organização usa SSO, autorize o token em **Configure SSO**.
- **Fine-grained** (pelo que sei, suportado para Projects de organização): *Resource owner* = a organização; permissão de organização **Projects: Read and write** e de repositório **Issues: Read and write**. A organização pode exigir aprovação.

Salve como secret `PROJECT_TOKEN`. Sem `APP_ID`, o workflow usa esse secret.

### 4.4 Configuração do workflow

No bloco `env` do passo **Rollup de status** em `status-rollup_org.yml`:

```yaml
PROJECT_OWNER: ${{ github.repository_owner }}   # login da organização
PROJECT_NUMBER: '1'                             # número do Project (URL)
STATUS_TODO: 'Todo'
STATUS_IN_PROGRESS: 'In progress'
STATUS_DONE: 'Done'
STATUS_IGNORE: ''
REOPEN_CLOSED: 'true'
REOPEN_GRACE_MINUTES: '2'
```

Se o workflow estiver num repositório **fora** da organização dona do Project, escreva o login da organização em `PROJECT_OWNER`.

### 4.5 Teste

Siga o mesmo roteiro da seção 3.5, começando por `dry_run`. O log da versão org traz `repo#número título`:

```
org/repo#12 Feature A: Todo -> In progress (dry-run)
Concluído: 1 alteração(ões).
```

### 4.6 O que validar antes de depender

- O App enxerga o Project (permissão **Projects** da organização) e as issues de todos os repositórios envolvidos.
- Sub-issues entre repositórios diferentes são lidas corretamente.
- O passo de geração de token do App funciona com a versão da action usada.

---

## 5. Solução de problemas (ambos os cenários)

| Sintoma | Causa provável e correção |
|---|---|
| `Project N não encontrado` | Owner ou número errado, ou o token/App sem acesso. Confira `PROJECT_OWNER`, `PROJECT_NUMBER` e as permissões. No cenário A, a query usa `user(login:)`: o Project precisa ser de usuário. |
| `Resource not accessible by integration` | (Org) O App sem permissão **Projects** ou não instalado na organização. |
| `Opção de Status "X" não existe` | Nome diferente do Project (ex.: `In progress` vs `In Progress`). Copie da lista exibida no erro. |
| `STATUS_IGNORE "X" não existe` | (Org) Nome inexistente no campo Status. |
| `0 alteração(ões)` mas deveria haver | Task não ligada como **sub-issue**, fora do Project, ou em repositório sem acesso do token/App. |
| Passo `Gerar token do GitHub App` falha | (Org) `APP_ID`/`APP_PRIVATE_KEY` incorretos ou App não instalado. Verifique se o `.pem` foi colado completo. |
| Botão **Run workflow** não aparece | Arquivo fora da branch padrão ou de `.github/workflows/`, ou sem `workflow_dispatch`. Verifique também se o Actions está habilitado. |
| Cron não roda | O GitHub atrasa execuções agendadas em horários de pico. Em repositórios públicos, workflows agendados são desativados após 60 dias sem atividade: reative em **Actions**. |
| Issue continua fechada com status *In progress* / *Todo* | Ainda dentro da carência (`REOPEN_GRACE_MINUTES`), `REOPEN_CLOSED: 'false'`, ou token sem permissão de escrita em Issues. |
| Status de um item volta para *Todo* ao reabrir | O workflow nativo **Item reopened** está ativo. Desative-o em ⋯ → Workflows. |
| Pai em *Blocked* não muda | Intencional: status fora do trio *Todo/In progress/Done* não é sobrescrito. |
| Push de `.github/workflows/` recusado | Se subir por token, ele precisa de permissão de workflow (`workflow` no PAT). Pelo git local com sua conta normal não há problema. |

---

## 6. Limitações e boas práticas

- O atraso máximo entre a mudança e o rollup é de alguns minutos.
- Pais são recalculados a cada execução: **alterações manuais no status de um pai com filhos podem ser revertidas**. Para travar um pai, use um status fora do trio (ex.: *Blocked*).
- A barra de progresso nativa das sub-issues conta issues **fechadas**, não o campo Status. Mantenha o workflow nativo do Project ("Item closed → Done" e auto-close) alinhado com esta automação.
- O script lê até 100 sub-issues por pai e pagina os itens do Project.
- Mantenha credenciais (PAT, `.pem`) fora do repositório e rotacione-as se houver suspeita de vazamento.

---

## 7. Tempo real (opcional)

Para eliminar o atraso do cron em uma **organização**, é possível criar um webhook do evento `projects_v2_item` (Organization settings → Webhooks). Como esse evento não dispara workflows diretamente, é necessário um pequeno receptor (por exemplo, uma função serverless) que valide a requisição e chame a API `repository_dispatch` ou `workflow_dispatch` do repositório; para o primeiro, adicione `repository_dispatch` ao bloco `on:` do workflow. Só vale a pena se o atraso de alguns minutos for um problema.

---

## 8. Histórico

| Versão | Descrição |
|---|---|
| v1 (cenário A) | Projeto pessoal com cron + PAT. Implementado e validado, incluindo 3 níveis e reabertura. |
| v2 (cenário B) | Versão para organização (`_org`): `repositoryOwner`, GitHub App, logs legíveis e validação de `STATUS_IGNORE`. Artefato, não validado em org. |
| v3 (A e B) | Reabertura de issues fechadas que voltam para *Todo* / *In progress* (`REOPEN_CLOSED`, `REOPEN_GRACE_MINUTES`). Cenário A validado no GitHub; cenário B exige Issues: Read and write no App/PAT e continua sem validação em org. |
| v4 (A e B) | Status do pai só pelas folhas: removida a regra que mantinha o pai em *In progress* com todas as filhas em *Todo*; folha em *Done* com issue aberta não conta como concluída. Cenário A validado no GitHub; cenário B sem validação em org. |
