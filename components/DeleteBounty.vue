<template>
  <div
    class="modal fade"
    id="delete-bounty-modal"
    ref="delete-bounty-modal"
    tabindex="-1"
    role="dialog"
  >
    <div class="modal-dialog text-dark text-left" role="document">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">Delete Bounty</h5>
          <button
            type="button"
            class="close"
            data-dismiss="modal"
            aria-label="Close"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <div class="modal-body" v-if="bounty">
          <h1 class="text-center">
            ${{ bounty.balance ? bounty.balance.toFixed(2) : "0.00" }}
          </h1>

          <p class="lead text-center">
            Do you really want to delete this bounty?
          </p>

          <div class="alert alert-info" v-if="bounty.balance > 0">
            Existing deposits as well as deposits made after deleting the bounty
            will be transfered to your GitHub account.
          </div>
        </div>
        <div class="modal-footer">
          <button
            @click.prevent="deleteBounty()"
            type="button"
            class="btn btn-danger"
          >
            <font-awesome-icon v-if="loading" icon="spinner" spin />
            <span v-else>Delete Bounty</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { mapGetters } from "vuex";

export default {
  props: ["bounty"],
  data() {
    return {
      loading: false,
      showSuccessMessage: false,
      showErrorMessage: false
    };
  },
  computed: {
    ...mapGetters("github", {
      githubUser: "user",
      githubAccessToken: "accessToken"
    })
  },
  methods: {
    deleteBounty() {
      if (this.githubUser) {
        this.loading = true;
        this.$axios
          .$post(process.env.API_URL + "/delete-bounty", {
            githubAccessToken: this.githubAccessToken,
            bountyId: this.bounty.id
          })
          .then(() => {
            this.$store.dispatch("loadBounties");
            $(this.$refs["delete-bounty-modal"]).modal("hide");
          })
          .finally(() => (this.loading = false));
      }
    }
  }
};
</script>
