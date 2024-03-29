import axios from "axios";
import crypto from "crypto";
import steemconnect from "steemconnect";
import steem from "steem";
import database from "../database";
import {
  getPullRequest,
  getIssuesByPR,
  calculateScore,
  getAge
} from "../../lib/helpers";

require("dotenv").config();

const steemconnectClient = new steemconnect.Client({
  app: "merge-rewards",
  callbackURL:
    process.env.SC_REDIRECT_URL || "http://localhost:3000/auth/steemconnect",
  scope: ["vote", "comment"]
});

const QUERY_EXISTING_PULL_REQUEST =
  "SELECT id FROM claims WHERE pullRequestId = ?";
const INSERT_CLAIM =
  "INSERT INTO claims (pullRequestId, score, permlink, githubUser, steemUser, pendingRewards, rewards, booster) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const DELETE_CLAIM = "DELETE FROM claims WHERE pullRequestId = ?";
const UPDATE_BOOSTER = "UPDATE boosters SET ?? = ?? - 1 WHERE githubUser = ?";
const QUERY_BOOSTER = "SELECT ?? FROM boosters WHERE githubUser = ?";
const RELEASE_BOUNTY =
  "UPDATE bounties SET releasedTo = ?, releasedAt = ?, claimId = ? WHERE autoRelease = 1 AND issueRepo = ? AND issueOwner = ? AND issueNum = ?";

export default (req, res) => {
  const githubUser = res.locals.authenticatedGithubUser.login;
  const githubAccessToken = req.body.githubAccessToken;
  const steemconnectAccessToken = req.body.steemconnectAccessToken;
  const pullRequest = req.body.pr;
  const booster = req.body.booster;

  // check if user has booster
  database.query(QUERY_BOOSTER, [booster, githubUser], (error, result) => {
    if (booster && error) {
      // error only relevant if booster is used
      res.status(500);
      res.send("Bad Request: Could not read available boosters from database.");
    } else {
      if (!booster || (result.length && result[0][booster])) {
        database.query(
          QUERY_EXISTING_PULL_REQUEST,
          [pullRequest.id],
          (error, result) => {
            if (error) {
              res.status(500);
              res.send("Error: Reading from database failed.");
            } else if (result.length === 1) {
              res.status(400);
              res.send(
                "Bad Request: Already claimed rewards for this pull request."
              );
            } else {
              getPullRequest(pullRequest, githubAccessToken).then(response => {
                const repo = response.data.data.repository;
                const viewer = response.data.data.viewer;

                if (
                  getAge(repo.pullRequest.mergedAt) <= process.env.PR_MAX_AGE
                ) {
                  if (repo.pullRequest.merged) {
                    if (!repo.viewerCanAdminister) {
                      getIssuesByPR(repo, githubAccessToken).then(issues => {
                        issues = issues.filter(i => i); // remove null
                        const score = calculateScore(repo, viewer, booster);
                        const permlink =
                          crypto
                            .createHash("md5")
                            .update(repo.pullRequest.permalink)
                            .digest("hex") + new Date().getTime();
                        const title = "PR: " + repo.pullRequest.permalink;
                        const body =
                          "PR: " +
                          `${repo.pullRequest.permalink} (Score: ${score})`;
                        const jsonMetadata = { app: "merge-rewards.com" };
                        const claimData = [
                          repo.pullRequest.id,
                          score,
                          permlink,
                          githubUser,
                          process.env.ACCOUNT_NAME,
                          null,
                          null,
                          booster
                        ];
                        if (steemconnectAccessToken) {
                          steemconnectClient.setAccessToken(
                            steemconnectAccessToken
                          );
                          steemconnectClient.me((error, steemUser) => {
                            if (error) {
                              res.status(500);
                              res.send(
                                `Error: Unable to connect to steem: ${
                                  error.error_description
                                }`
                              );
                            } else {
                              claimData[4] = steemUser.account.name;
                              database.query(
                                INSERT_CLAIM,
                                claimData,
                                (error, result) => {
                                  if (error) {
                                    res.status(500);
                                    res.send(
                                      "Error: Writing to database failed."
                                    );
                                  } else {
                                    steemconnectClient.comment(
                                      process.env.ACCOUNT_NAME,
                                      process.env.ROOT_POST_PERMLINK,
                                      steemUser.user,
                                      permlink,
                                      title,
                                      body,
                                      jsonMetadata,
                                      error => {
                                        if (error) {
                                          database.query(DELETE_CLAIM, [
                                            repo.pullRequest.id
                                          ]);
                                          res.status(500);
                                          res.send(
                                            "Error: Posting to STEEM blockchain failed."
                                          );
                                        } else {
                                          if (booster) {
                                            // remove booster from user balance
                                            database.query(UPDATE_BOOSTER, [
                                              booster,
                                              booster,
                                              githubUser
                                            ]);
                                          }
                                          if (issues) {
                                            issues.forEach(issue => {
                                              database.query(RELEASE_BOUNTY, [
                                                githubUser,
                                                new Date(),
                                                result.insertId,
                                                repo.name,
                                                repo.owner.login,
                                                issue.number
                                              ]);
                                            });
                                          }
                                          res.status(201);
                                          res.send();
                                        }
                                      }
                                    );
                                  }
                                }
                              );
                            }
                          });
                        } else {
                          database.query(
                            INSERT_CLAIM,
                            claimData,
                            (error, result) => {
                              if (error) {
                                res.status(500);
                                res.send("Error: Writing to database failed.");
                              } else {
                                steem.broadcast.comment(
                                  process.env.ACCOUNT_KEY,
                                  process.env.ACCOUNT_NAME,
                                  process.env.ROOT_POST_PERMLINK,
                                  process.env.ACCOUNT_NAME,
                                  permlink,
                                  title,
                                  body,
                                  jsonMetadata,
                                  error => {
                                    if (error) {
                                      database.query(DELETE_CLAIM, [
                                        repo.pullRequest.id
                                      ]);
                                      res.status(500);
                                      res.send(
                                        "Error: Posting to STEEM blockchain failed."
                                      );
                                    } else {
                                      if (booster) {
                                        database.query(UPDATE_BOOSTER, [
                                          booster,
                                          booster,
                                          githubUser
                                        ]);
                                      }
                                      if (issues) {
                                        issues.forEach(issue => {
                                          database.query(RELEASE_BOUNTY, [
                                            githubUser,
                                            new Date(),
                                            result.insertId,
                                            repo.name,
                                            repo.owner.login,
                                            issue.number
                                          ]);
                                        });
                                      }
                                      res.status(201);
                                      res.send();
                                    }
                                  }
                                );
                              }
                            }
                          );
                        }
                      });
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
          }
        );
      } else {
        res.status(400);
        res.send("Bad Request: Booster not available");
      }
    }
  });
};
