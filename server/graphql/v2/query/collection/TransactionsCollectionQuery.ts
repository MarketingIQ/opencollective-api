import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { cloneDeep, flatten, isEmpty, isNil, pick, uniq } from 'lodash';
import { Order } from 'sequelize';

import { CollectiveType } from '../../../../constants/collectives';
import { buildSearchConditions } from '../../../../lib/search';
import models, { Op, sequelize } from '../../../../models';
import { checkScope } from '../../../common/scope-check';
import {
  GraphQLTransactionCollection,
  GraphQLTransactionsCollectionReturnType,
} from '../../collection/TransactionCollection';
import { GraphQLExpenseType } from '../../enum/ExpenseType';
import { GraphQLPaymentMethodType } from '../../enum/PaymentMethodType';
import { GraphQLTransactionKind } from '../../enum/TransactionKind';
import { GraphQLTransactionType } from '../../enum/TransactionType';
import {
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../../input/AccountReferenceInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../../input/ChronologicalOrderInput';
import { getDatabaseIdFromExpenseReference, GraphQLExpenseReferenceInput } from '../../input/ExpenseReferenceInput';
import { getDatabaseIdFromOrderReference, GraphQLOrderReferenceInput } from '../../input/OrderReferenceInput';
import { GraphQLVirtualCardReferenceInput } from '../../input/VirtualCardReferenceInput';
import { CollectionArgs } from '../../interface/Collection';

export const TransactionsCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  type: {
    type: GraphQLTransactionType,
    description: 'The transaction type (DEBIT or CREDIT)',
  },
  paymentMethodType: {
    type: new GraphQLList(GraphQLPaymentMethodType),
    description: 'The payment method types. Can include `null` for transactions without a payment method',
  },
  fromAccount: {
    type: GraphQLAccountReferenceInput,
    description:
      'Reference of the account assigned to the other side of the transaction (CREDIT -> sender, DEBIT -> recipient). Avoid, favor account instead.',
  },
  host: {
    type: GraphQLAccountReferenceInput,
    description: 'Reference of the host accounting the transaction',
  },
  tags: {
    type: new GraphQLList(GraphQLString),
    description: 'NOT IMPLEMENTED. Only return transactions that match these tags.',
    deprecationReason: '2020-08-09: Was never implemented.',
  },
  orderBy: {
    type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
    description: 'The order of results',
    defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  },
  minAmount: {
    type: GraphQLInt,
    description: 'Only return transactions where the amount is greater than or equal to this value (in cents)',
    deprecationReason: '2020-08-09: GraphQL v2 should not expose amounts as integer.',
  },
  maxAmount: {
    type: GraphQLInt,
    description: 'Only return transactions where the amount is lower than or equal to this value (in cents)',
    deprecationReason: '2020-08-09: GraphQL v2 should not expose amounts as integer.',
  },
  dateFrom: {
    type: GraphQLDateTime,
    description: 'Only return transactions that were created after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'Only return transactions that were created before this date',
  },
  searchTerm: {
    type: GraphQLString,
    description: 'The term to search',
  },
  hasExpense: {
    type: GraphQLBoolean,
    description: 'Only return transactions with an Expense attached',
  },
  expense: {
    type: GraphQLExpenseReferenceInput,
    description: 'Only return transactions with this Expense attached',
  },
  expenseType: {
    type: new GraphQLList(GraphQLExpenseType),
    description: 'Only return transactions that have an Expense of one of these expense types attached',
  },
  hasOrder: {
    type: GraphQLBoolean,
    description: 'Only return transactions with an Order attached',
  },
  order: {
    type: GraphQLOrderReferenceInput,
    description: 'Only return transactions for this order.',
  },
  includeHost: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: true,
    description:
      'Used when filtering with the `host` argument to determine whether to include transactions on the fiscal host account (and children)',
  },
  includeRegularTransactions: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: true,
    description:
      'Whether to include regular transactions from the account (turn false if you only want Incognito or Gift Card transactions)',
  },
  includeIncognitoTransactions: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: false,
    description:
      'If the account is a user and this field is true, contributions from the incognito profile will be included too (admins only)',
  },
  includeChildrenTransactions: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: false,
    description: 'Whether to include transactions from children (Events and Projects)',
  },
  includeGiftCardTransactions: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: false,
    description: 'Whether to include transactions from Gift Cards issued by the account.',
  },
  includeDebts: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: false,
    description: 'Whether to include debt transactions',
  },
  kind: {
    type: new GraphQLList(GraphQLTransactionKind),
    description: 'To filter by transaction kind',
  },
  group: {
    type: GraphQLString,
    description: 'The transactions group to filter by',
  },
  virtualCard: {
    type: new GraphQLList(GraphQLVirtualCardReferenceInput),
  },
};

export const TransactionsCollectionResolver = async (
  args,
  req: express.Request,
): Promise<GraphQLTransactionsCollectionReturnType> => {
  const where = [];
  const include = [];

  // Check Pagination arguments
  if (isNil(args.limit) || args.limit < 0) {
    args.limit = 100;
  }
  if (isNil(args.offset) || args.offset < 0) {
    args.offset = 0;
  }
  if (args.limit > 10000 && !req.remoteUser?.isRoot()) {
    throw new Error('Cannot fetch more than 10,000 transactions at the same time, please adjust the limit');
  }

  // Load accounts
  const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
  const [fromAccount, host] = await Promise.all(
    [args.fromAccount, args.host].map(
      reference => reference && fetchAccountWithReference(reference, fetchAccountParams),
    ),
  );

  if (fromAccount) {
    const fromAccountCondition = [];

    if (args.includeRegularTransactions) {
      fromAccountCondition.push(fromAccount.id);
    }

    if (args.includeChildrenTransactions) {
      const childIds = await fromAccount.getChildren().then(children => children.map(child => child.id));
      fromAccountCondition.push(...childIds);
    }

    // When users are admins, also fetch their incognito contributions
    if (
      args.includeIncognitoTransactions &&
      req.remoteUser?.isAdminOfCollective(fromAccount) &&
      req.remoteUser.CollectiveId === fromAccount.id &&
      checkScope(req, 'incognito')
    ) {
      const incognitoProfile = await fromAccount.getIncognitoProfile();
      if (incognitoProfile) {
        fromAccountCondition.push(incognitoProfile.id);
      }
    }

    if (args.includeGiftCardTransactions) {
      where.push({
        [Op.or]: [
          { UsingGiftCardFromCollectiveId: fromAccount.id, type: 'CREDIT' },
          // prettier, please keep line break for readability please
          { FromCollectiveId: fromAccountCondition },
        ],
      });
    } else {
      where.push({ FromCollectiveId: fromAccountCondition });
    }
  }

  if (args.account) {
    const accountCondition = [];
    const attributes = ['id']; // We only need IDs
    const fetchAccountsParams = { throwIfMissing: true, attributes };
    if (args.includeChildrenTransactions) {
      fetchAccountsParams['include'] = [
        { association: 'children', required: false, attributes, where: { type: { [Op.ne]: CollectiveType.VENDOR } } },
      ];
    }

    // Fetch accounts (and optionally their children)
    const accounts = await fetchAccountsWithReferences(args.account, fetchAccountsParams);
    const accountsIds = uniq(
      flatten(
        accounts.map(account => {
          const accountIds = args.includeRegularTransactions ? [account.id] : [];
          const childrenIds = account.children?.map(child => child.id) || [];
          return [...accountIds, ...childrenIds];
        }),
      ),
    );

    accountCondition.push(...accountsIds);

    // When the remote user is part of the fetched profiles, also fetch the linked incognito contributions
    if (req.remoteUser && args.includeIncognitoTransactions && checkScope(req, 'incognito')) {
      if (accountCondition.includes(req.remoteUser.CollectiveId)) {
        const incognitoProfile = await req.remoteUser.getIncognitoProfile();
        if (incognitoProfile) {
          accountCondition.push(incognitoProfile.id);
        }
      }
    }

    if (args.includeGiftCardTransactions) {
      where.push({
        [Op.or]: [
          { UsingGiftCardFromCollectiveId: accounts.map(account => account.id), type: 'DEBIT' },
          // prettier, please keep line break for readability please
          { CollectiveId: accountCondition },
        ],
      });
    } else {
      where.push({ CollectiveId: accountCondition });
    }
  }

  if (host) {
    if (args.includeHost === false) {
      const hostChildrenIds = await host
        .getChildren({ attributes: ['id'] })
        .then(children => children.map(child => child.id));
      const hostAccountsIds = [host.id, ...hostChildrenIds];

      where.push({ CollectiveId: { [Op.notIn]: hostAccountsIds } });
    }

    where.push({ HostCollectiveId: host.id });
  }

  // Backup the conditions as they're now to fetch the list of all available kinds
  const whereKinds = cloneDeep(where);

  // Handle search query
  const searchTermConditions = buildSearchConditions(args.searchTerm, {
    idFields: ['id', 'ExpenseId', 'OrderId'],
    slugFields: ['$fromCollective.slug$', '$collective.slug$'],
    textFields: ['$fromCollective.name$', '$collective.name$', 'description'],
    amountFields: ['amount'],
  });

  if (searchTermConditions.length) {
    where.push({ [Op.or]: searchTermConditions });
    include.push({ association: 'fromCollective', attributes: [] }, { association: 'collective', attributes: [] }); // Must include associations to search their fields
  }

  if (args.type) {
    where.push({ type: args.type });
  }
  if (args.group) {
    where.push({ TransactionGroup: args.group });
  }
  if (args.minAmount) {
    where.push({ amount: sequelize.where(sequelize.fn('abs', sequelize.col('amount')), Op.gte, args.minAmount) });
  }
  if (args.maxAmount) {
    let amount = sequelize.where(sequelize.fn('abs', sequelize.col('amount')), Op.lte, args.maxAmount);
    if (where['amount']) {
      amount = { [Op.and]: [where['amount'], amount] };
    }
    where.push({ amount });
  }
  if (args.dateFrom) {
    where.push({ createdAt: { [Op.gte]: args.dateFrom } });
  }
  if (args.dateTo) {
    where.push({ createdAt: { [Op.lte]: args.dateTo } });
  }
  if (args.expense) {
    const expenseId = getDatabaseIdFromExpenseReference(args.expense);
    where.push({ ExpenseId: expenseId });
  }
  if (args.hasExpense !== undefined) {
    where.push({ ExpenseId: { [args.hasExpense ? Op.ne : Op.eq]: null } });
  }
  if (args.expenseType) {
    include.push({
      model: models.Expense,
      attributes: [],
      required: true,
      where: { type: { [Op.in]: args.expenseType } },
    });
  }
  if (args.order) {
    const orderId = getDatabaseIdFromOrderReference(args.order);
    where.push({ OrderId: orderId });
  }
  if (args.hasOrder !== undefined) {
    where.push({ OrderId: { [args.hasOrder ? Op.ne : Op.eq]: null } });
  }
  if (!args.includeDebts) {
    where.push({ isDebt: { [Op.not]: true } });
  }
  if (args.kind) {
    where.push({ kind: args.kind });
  }
  if (args.paymentMethodType) {
    const uniquePaymentMethods: string[] = uniq(args.paymentMethodType);
    const paymentMethodConditions = uniquePaymentMethods.map(type => {
      return type ? { '$PaymentMethod.type$': type } : { PaymentMethodId: null };
    });

    if (paymentMethodConditions.length) {
      include.push({ model: models.PaymentMethod });
      where.push({ [Op.or]: paymentMethodConditions });
    }
  }

  if (!isEmpty(args.virtualCard)) {
    include.push({
      attributes: [],
      model: models.Expense,
      required: true,
      where: {
        VirtualCardId: args.virtualCard.map(vc => vc.id),
      },
    });
  }

  /* 
    Ordering of transactions by
    - createdAt (rounded by a 10s interval): to treat very close timestamps as the same to defer ordering to transaction group, kind and type
      - known issue: a transaction group can be split in two if the first transaction is rounded to the end of a 10s interval and the second to the beginning of the next 10s interval
    - TransactionGroup: to keep transactions of the same group together
    - kind: to put transactions in a group in a "logical" order following the main transaction
    - type: to put debits before credits of the same kind (i.e. when viewing multiple accounts at the same time)
*/
  const order: Order = [
    [
      sequelize.fn('ROUND', sequelize.literal('ROUND(EXTRACT(epoch FROM "Transaction"."createdAt") / 10)')),
      args.orderBy.direction,
    ],
    ['TransactionGroup', args.orderBy.direction],
    [
      sequelize.literal(`
        CASE
          WHEN "Transaction"."kind" IN ('CONTRIBUTION', 'EXPENSE', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD') THEN 1
          WHEN "Transaction"."kind" IN ('PLATFORM_TIP') THEN 2
          WHEN "Transaction"."kind" IN ('PLATFORM_TIP_DEBT') THEN 3
          WHEN "Transaction"."kind" IN ('PAYMENT_PROCESSOR_FEE') THEN 4
          WHEN "Transaction"."kind" IN ('PAYMENT_PROCESSOR_COVER') THEN 5
          WHEN "Transaction"."kind" IN ('HOST_FEE') THEN 6
          WHEN "Transaction"."kind" IN ('HOST_FEE_SHARE') THEN 7
          WHEN "Transaction"."kind" IN ('HOST_FEE_SHARE_DEBT') THEN 8
          ELSE 9
        END`),
      args.orderBy.direction,
    ],
    [
      sequelize.literal(`
        CASE
          WHEN "Transaction"."type" = 'DEBIT' THEN 1
          ELSE 2
        END`),
      args.orderBy.direction,
    ],
  ];

  const { offset, limit } = args;

  const queryParameters = {
    where: sequelize.and(...where),
    order,
    offset,
    limit,
    include,
  };

  let totalCount, nodes;
  if (limit === 0) {
    totalCount = await models.Transaction.count(pick(queryParameters, ['where']));
    nodes = [];
  } else {
    const result = await models.Transaction.findAndCountAll(queryParameters);
    totalCount = result.count;
    nodes = result.rows;
  }

  return {
    nodes,
    totalCount,
    limit: args.limit,
    offset: args.offset,
    kinds: async () => {
      const results = await models.Transaction.findAll({
        attributes: ['kind'],
        where: whereKinds,
        group: ['kind'],
        raw: true,
      });

      return results.map(m => m.kind).filter(kind => !!kind);
    },
    paymentMethodTypes: () => {
      return models.Transaction.findAll({
        attributes: ['PaymentMethod.type'],
        where: whereKinds,
        include: [{ model: models.PaymentMethod, required: false, attributes: [] }],
        group: ['PaymentMethod.type'],
        raw: true,
      }).then(results => {
        return results.map(result => result.type || null);
      });
    },
  };
};

const TransactionsCollectionQuery = {
  type: new GraphQLNonNull(GraphQLTransactionCollection),
  args: {
    account: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
      description:
        'Reference of the account(s) assigned to the main side of the transaction (CREDIT -> recipient, DEBIT -> sender)',
    },
    ...TransactionsCollectionArgs,
  },
  async resolve(_: void, args, req: express.Request): Promise<GraphQLTransactionsCollectionReturnType> {
    return TransactionsCollectionResolver(args, req);
  },
};

export default TransactionsCollectionQuery;
