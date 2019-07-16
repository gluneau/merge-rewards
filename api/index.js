const express = require("express");
const axios = require("axios");
const fs = require("fs");
const app = express();
const steemconnect = require("steemconnect");
const steem = require("steem");
const crypto = require("crypto");

const steemconnectClient = new steemconnect.Client({
  app: "merge-rewards",
  callbackURL:
    process.env.SC_REDIRECT_URL || "http://localhost:3000/auth/steemconnect",
  scope: ["vote", "comment"]
});

require("dotenv").config();

app.use(express.json());

const getDatabase = table => {
  return JSON.parse(
    fs.readFileSync(process.env.DATABASE + "/" + table + ".json", {
      encoding: "utf-8"
    })
  );
};

const updateDatabase = (table, data) => {
  fs.writeFileSync(
    process.env.DATABASE + "/" + table + ".json",
    JSON.stringify(data, null, 2)
  );
};

const getAge = createdAt =>
  (new Date().getTime() - new Date(createdAt).getTime()) /
  (60 * 60 * 24 * 1000);

const getMergedPRsLastMonth = pullRequests => {
  const mergedLastMonth = 0;
  pullRequests.forEach(pr => {
    const age = getAge(pr.createdAt);
    if (pr.merged && age <= 30) {
      mergedLastMonth++;
    }
  });
  return mergedLastMonth;
};

const calculateScore = (repo, user) => {
  const userAge = getAge(user.createdAt);
  const userFollowers = user.followers.totalCount;
  const mergedPRsLastMonth = getMergedPRsLastMonth(user.pullRequests.nodes);
  const repoAge = getAge(repo.createdAt);
  const repoStars = repo.stargazers.totalCount;
  const repoForks = repo.forkCount;
  let points = 0;

  if (userAge > 365) points += 2;
  if (userAge > 365 * 5) points += 4;
  if (userFollowers > 50) points += 1;
  if (userFollowers > 1000) points += 2;
  if (mergedPRsLastMonth > 2) points += 2;
  if (mergedPRsLastMonth > 10) points += 4;
  if (repoAge > 90) points += 2;
  if (repoAge > 365) points += 4;
  if (repoStars > 50) points += 1;
  if (repoStars > 250) points += 2;
  if (repoForks > 10) points += 2;
  if (repoForks > 50) points += 4;

  return Math.round((points / 30) * 100);
};

const getPullRequest = (pullRequest, githubAccessToken) => {
  return axios.post(
    "https://api.github.com/graphql",
    {
      query: `{
viewer {
  login
  createdAt,
  followers {
    totalCount
  }
  pullRequests(first: 100) {
    nodes {
      mergedAt
    }
  }
}
repository(owner: "${pullRequest.repository.owner.login}", name: "${
        pullRequest.repository.name
      }") {
  name
  createdAt
  forkCount
  viewerCanAdminister
  stargazers {
    totalCount
  }
  pullRequest(number: ${pullRequest.number}) {
    id
    merged
    mergedAt
    permalink
  }
}
}`
    },
    {
      headers: {
        Authorization: "bearer " + githubAccessToken
      }
    }
  );
};

app.post("/github/access-token", (req, res) => {
  let code = req.body.code;
  axios
    .post("https://github.com/login/oauth/access_token", {
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      accept: "application/json"
    })
    .then(response => {
      const urlParams = new URLSearchParams(response.data);
      const accessToken = urlParams.get("access_token");
      res.json({ accessToken });
    });
});

app.get("/database/:table", (req, res) => {
  const database = getDatabase(req.params.table);
  res.json(database);
});

app.get("/rewards/:githubUser", (req, res) => {
  const githubUser = req.params.githubUser;
  // sum all claimed rewards
  const claims = getDatabase("claims");
  const rewards = claims.reduce(
    (r, pr) => {
      if (pr.githubUser === githubUser && pr.steemUser === "merge-rewards") {
        if (pr.rewards) r.rewards += parseFloat(pr.rewards);
        if (pr.pendingRewards) r.pending += parseFloat(pr.pendingRewards);
      }
      return r;
    },
    { rewards: 0, pending: 0 }
  );
  // substract all withdrawn rewards
  const withdrawals = getDatabase("withdrawals");
  withdrawals.forEach(w => {
    if (w.githubUser === githubUser) {
      rewards.rewards -= w.amount;
    }
  });
  res.json(rewards);
});

app.post("/withdraw", (req, res) => {
  const githubUser = req.body.githubUser;
  const amount = req.body.amount;
  const formattedAmount = amount.toFixed(3) + " SBD";
  const currency = req.body.currency;
  const address = req.body.address;
  const withdrawals = getDatabase("withdrawals");
  axios
    .get(process.env.API_URL + "/rewards/" + githubUser)
    .then(response => {
      const balance = response.data;
      if (balance.rewards >= amount) {
        if (["btc", "ltc", "eth", "xmr"].includes(currency)) {
          if (amount >= 5) {
            axios
              .post("https://blocktrades.us/api/v2/sessions")
              .then(response => {
                const session = response.data;
                axios
                  .post(
                    "https://blocktrades.us/api/v2/simple-api/initiate-trade",
                    {
                      inputCoinType: "sbd",
                      outputCoinType: currency,
                      outputAddress: address,
                      affiliateId: "b8ac630a-5e6e-4b00-a8a8-46c33cb7488a",
                      refundAddress: "merge-rewards",
                      sessionToken: session.token
                    }
                  )
                  .then(response => {
                    const transfer = response.data;
                    steem.broadcast.transfer(
                      process.env.ACCOUNT_KEY,
                      "merge-rewards",
                      transfer.inputAddress,
                      formattedAmount,
                      transfer.inputMemo,
                      (err, result) => {
                        if (err) {
                          res.status(500);
                          res.json(err);
                        } else {
                          withdrawals.push({ amount, githubUser });
                          updateDatabase("withdrawals", withdrawals);
                          res.json(result);
                        }
                      }
                    );
                  })
                  .catch(e => {
                    res.status(400);
                    res.json(e.response.data.error);
                  });
              })
              .catch(e => {
                res.status(400);
                res.json(e.response.data.error);
              });
          } else {
            res.status(400);
            res.send("Bad request: Minimum withdrawal amount is 5$.");
          }
        } else if (currency === "steem") {
          // check if account exists
          steem.api.getAccounts([address], (err, response) => {
            if (err) {
              res.status(500);
              res.send("Error: Steem username lookup failed.");
            } else {
              if (response.length === 1) {
                // transfer
                steem.broadcast.transfer(
                  process.env.ACCOUNT_KEY,
                  "merge-rewards",
                  address,
                  formattedAmount,
                  "merge-rewards.com withdrawal",
                  (err, result) => {
                    if (err) {
                      res.status(500);
                      res.json(err);
                    } else {
                      withdrawals.push({ amount, githubUser });
                      updateDatabase("withdrawals", withdrawals);
                      res.json(result);
                    }
                  }
                );
              } else {
                res.status(400);
                res.send("Bad Request: Steem username does not exist.");
              }
            }
          });
        } else {
          res.status(400);
          res.send("Bad Request: No supported currency was selected.");
        }
      } else {
        res.status(400);
        res.send("Bad Request: Balance not sufficiant.");
      }
    })
    .catch(e => {
      res.status(500);
      res.send("Error: Could not fetch balance for GitHub user " + githubUser);
    });
});

app.post("/score", (req, res) => {
  const pullRequest = req.body.pr;
  const githubAccessToken = req.body.githubAccessToken;
  getPullRequest(pullRequest, githubAccessToken).then(response => {
    const repo = response.data.data.repository;
    const user = response.data.data.viewer;
    const score = calculateScore(repo, user);
    res.json({ score });
  });
});

app.post("/claim", (req, res) => {
  const pullRequest = req.body.pr;
  const githubAccessToken = req.body.githubAccessToken;
  const steemconnectAccessToken = req.body.steemconnectAccessToken;
  const database = getDatabase("claims");
  const existingPr = database.find(pr => pr.id === pullRequest.id);
  if (existingPr) {
    res.status(400);
    res.send("Bad request: Already claimed rewards for this pull request.");
  } else {
    getPullRequest(pullRequest, githubAccessToken).then(response => {
      const repo = response.data.data.repository;
      const user = response.data.data.viewer;

      if (getAge(repo.pullRequest.mergedAt) <= process.env.PR_MAX_AGE) {
        if (repo.pullRequest.merged) {
          if (!repo.viewerCanAdminister) {
            const score = calculateScore(repo, user);
            const permlink = crypto
              .createHash("md5")
              .update(repo.pullRequest.permalink)
              .digest("hex");
            const title = "PR: " + repo.pullRequest.permalink;
            const body =
              "PR: " + `${repo.pullRequest.permalink} (Score: ${score})`;
            const jsonMetadata = {
              id: repo.pullRequest.id,
              score,
              permlink,
              githubUser: user.login,
              steemUser: "merge-rewards",
              pendingRewards: null,
              rewards: null
            };
            if (!steemconnectAccessToken) {
              steem.broadcast.comment(
                process.env.ACCOUNT_KEY,
                "merge-rewards",
                "merge-rewards-beta-root-post",
                "merge-rewards",
                permlink,
                title,
                body,
                jsonMetadata,
                (error, response) => {
                  if (error) {
                    res.status(400);
                    res.send(`Error: Posting to STEEM blockchain failed.`);
                  } else {
                    database.push(jsonMetadata);
                    updateDatabase("claims", database);
                    res.status(201);
                    res.send(`Pull request accepted: Score: ${score}`);
                  }
                }
              );
            } else {
              steemconnectClient.setAccessToken(steemconnectAccessToken);
              steemconnectClient.me((error, steemUser) => {
                jsonMetadata.steemUser = steemUser.account.name;
                if (error) {
                  res.status(400);
                  res.send(
                    `Bad request: Unable to connect to steem: ${
                      error.error_description
                    }`
                  );
                } else {
                  steemconnectClient.comment(
                    "merge-rewards",
                    "merge-rewards-beta-root-post",
                    steemUser.user,
                    permlink,
                    title,
                    body,
                    jsonMetadata,
                    (error, response) => {
                      if (error) {
                        res.status(400);
                        res.send(`Error: Posting to STEEM blockchain failed.`);
                      } else {
                        database.push(jsonMetadata);
                        updateDatabase("claims", database);
                        res.status(201);
                        res.send(`Pull request accepted: Score: ${score}`);
                      }
                    }
                  );
                }
              });
            }
          } else {
            res.status(400);
            res.send(
              "Bad request: Unmet requirements: Pull request is for your own repository."
            );
          }
        } else {
          res.status(400);
          res.send(
            "Bad request: Unmet requirements: Pull request is not merged."
          );
        }
      } else {
        res.status(400);
        res.send(
          "Bad request: Unmet requirements: Pull request was merged more than " +
            process.env.PR_MAX_AGE +
            " days ago."
        );
      }
    });
  }
});

module.exports = {
  path: "/api",
  handler: app
};
